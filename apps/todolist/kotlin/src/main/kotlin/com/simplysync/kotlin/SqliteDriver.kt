package com.simplysync.kotlin

import java.sql.DriverManager
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * A value read from or bound to a SQLite cell. Mirrors SQLite's storage classes;
 * the engine maps `JsonValue` to and from these.
 */
sealed class SqliteValue {
    data class Text(val value: String) : SqliteValue()
    data class Integer(val value: Long) : SqliteValue()
    data class Real(val value: Double) : SqliteValue()
    data class Blob(val value: ByteArray) : SqliteValue() {
        override fun equals(other: Any?) = other is Blob && value.contentEquals(other.value)
        override fun hashCode() = value.contentHashCode()
    }
    data object Null : SqliteValue()
}

/** One result row with typed accessors — what a `Query`'s mapper receives. */
class Row(val columns: Map<String, SqliteValue>) {
    fun has(key: String): Boolean = columns[key] != null && columns[key] != SqliteValue.Null
    fun stringOrNull(key: String): String? = (columns[key] as? SqliteValue.Text)?.value
    fun string(key: String): String = stringOrNull(key) ?: ""
    fun long(key: String): Long = when (val v = columns[key]) {
        is SqliteValue.Integer -> v.value
        is SqliteValue.Real -> v.value.toLong()
        is SqliteValue.Text -> v.value.toLongOrNull() ?: 0
        else -> 0
    }
    fun int(key: String): Int = long(key).toInt()
    fun double(key: String): Double = when (val v = columns[key]) {
        is SqliteValue.Real -> v.value
        is SqliteValue.Integer -> v.value.toDouble()
        is SqliteValue.Text -> v.value.toDoubleOrNull() ?: 0.0
        else -> 0.0
    }
    fun boolean(key: String): Boolean = long(key) != 0L
}

/**
 * A thin synchronous wrapper over a platform SQLite — the Kotlin port of the
 * engine's `SqliteDriver`. The engine injects one (the default is the
 * JDBC-backed `JdbcSqliteDriver`), so the engine stays storage-agnostic. Android
 * apps inject an `android.database`-backed implementation.
 */
interface SqliteDriver {
    fun exec(sql: String, params: List<SqliteValue> = emptyList())
    fun select(sql: String, params: List<SqliteValue> = emptyList()): List<Map<String, SqliteValue>>
    fun <T> transaction(body: () -> T): T
    fun close() {}
}

class SqliteException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * A pure-JVM SQLite driver over `org.xerial:sqlite-jdbc` — no Android framework
 * dependency. Access is serialized with a reentrant lock so the engine's
 * background sync and foreground writes can't interleave statements on the one
 * connection. Pass `":memory:"` for an in-memory database (used by tests).
 */
class JdbcSqliteDriver(path: String) : SqliteDriver {
    private val conn = DriverManager.getConnection("jdbc:sqlite:$path")
    private val lock = ReentrantLock()

    override fun exec(sql: String, params: List<SqliteValue>) = lock.withLock {
        conn.prepareStatement(sql).use { stmt ->
            bind(stmt, params)
            stmt.execute()
            Unit
        }
    }

    override fun select(sql: String, params: List<SqliteValue>): List<Map<String, SqliteValue>> = lock.withLock {
        conn.prepareStatement(sql).use { stmt ->
            bind(stmt, params)
            stmt.executeQuery().use { rs -> readRows(rs) }
        }
    }

    override fun <T> transaction(body: () -> T): T = lock.withLock {
        val previous = conn.autoCommit
        conn.autoCommit = false
        try {
            val result = body()
            conn.commit()
            result
        } catch (t: Throwable) {
            runCatching { conn.rollback() }
            throw t
        } finally {
            conn.autoCommit = previous
        }
    }

    override fun close() = lock.withLock { conn.close() }

    private fun bind(stmt: PreparedStatement, params: List<SqliteValue>) {
        params.forEachIndexed { i, value ->
            val idx = i + 1
            when (value) {
                is SqliteValue.Text -> stmt.setString(idx, value.value)
                is SqliteValue.Integer -> stmt.setLong(idx, value.value)
                is SqliteValue.Real -> stmt.setDouble(idx, value.value)
                is SqliteValue.Blob -> stmt.setBytes(idx, value.value)
                SqliteValue.Null -> stmt.setObject(idx, null)
            }
        }
    }

    private fun readRows(rs: ResultSet): List<Map<String, SqliteValue>> {
        val meta = rs.metaData
        val count = meta.columnCount
        val rows = ArrayList<Map<String, SqliteValue>>()
        while (rs.next()) {
            val row = LinkedHashMap<String, SqliteValue>(count)
            for (i in 1..count) {
                val name = meta.getColumnLabel(i)
                row[name] = when (val o = rs.getObject(i)) {
                    null -> SqliteValue.Null
                    is Long -> SqliteValue.Integer(o)
                    is Int -> SqliteValue.Integer(o.toLong())
                    is Short -> SqliteValue.Integer(o.toLong())
                    is Double -> SqliteValue.Real(o)
                    is Float -> SqliteValue.Real(o.toDouble())
                    is ByteArray -> SqliteValue.Blob(o)
                    is String -> SqliteValue.Text(o)
                    else -> SqliteValue.Text(o.toString())
                }
            }
            rows.add(row)
        }
        return rows
    }
}
