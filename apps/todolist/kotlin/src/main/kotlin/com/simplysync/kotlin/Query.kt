package com.simplysync.kotlin

/**
 * A compiled query — raw SQL plus bound parameters and a mapper that turns each
 * result [Row] into a typed value. Build one with `engine.createQuery(...)`. Use
 * double-quoted table names (e.g. `from "todo"`) so the cache can tell which
 * writes affect it.
 */
class Query<T>(
    val sql: String,
    val parameters: List<SqliteValue> = emptyList(),
    val map: (Row) -> T,
) {
    val key: String get() = cacheKey(sql, parameters)

    companion object {
        fun cacheKey(sql: String, params: List<SqliteValue>): String =
            sql + "::" + params.joinToString(",") { describe(it) }

        private fun describe(v: SqliteValue): String = when (v) {
            is SqliteValue.Text -> "t:${v.value}"
            is SqliteValue.Integer -> "i:${v.value}"
            is SqliteValue.Real -> "r:${v.value}"
            is SqliteValue.Blob -> "b:${v.value.size}"
            SqliteValue.Null -> "n"
        }
    }
}

/**
 * The reactive query cache — the Kotlin port of the engine's query cache. Each
 * distinct `sql::params` is cached with its raw rows; a mutation/sync calls
 * `refreshQueries(changedTables)`, which re-runs only the queries whose tables
 * overlap and fires their listeners. Not internally locked — the engine
 * serializes all access.
 */
class QueryCache(private val store: Store, private val schema: Schema) {
    private class Entry(
        val sql: String,
        val params: List<SqliteValue>,
        val tables: Set<String>,
        var rows: List<Map<String, SqliteValue>>,
    ) {
        val listeners = LinkedHashMap<Long, () -> Unit>()
    }

    private val entries = HashMap<String, Entry>()
    private var nextListenerId = 0L
    var schemaReady = false
    var onError: ((String) -> Unit)? = null
    private var reportedError = false

    private fun tablesInSql(sql: String): Set<String> =
        schema.tableNames.filter { sql.contains("\"$it\"") }.toSet()

    private fun runQuery(sql: String, params: List<SqliteValue>): List<Map<String, SqliteValue>> {
        val driver = store.driver ?: return emptyList()
        return try {
            driver.select(sql, params)
        } catch (e: Exception) {
            if (schemaReady && !reportedError) {
                reportedError = true
                onError?.invoke(e.message ?: e.toString())
            }
            emptyList()
        }
    }

    private fun <T> entryFor(query: Query<T>): Entry {
        entries[query.key]?.let { return it }
        val entry = Entry(
            query.sql, query.parameters, tablesInSql(query.sql),
            if (store.driver != null) runQuery(query.sql, query.parameters) else emptyList(),
        )
        entries[query.key] = entry
        return entry
    }

    fun <T> rawRows(query: Query<T>): List<Map<String, SqliteValue>> = entryFor(query).rows

    fun <T> loadRawRows(query: Query<T>): List<Map<String, SqliteValue>> {
        val rows = runQuery(query.sql, query.parameters)
        entries[query.key]?.rows = rows
        return rows
    }

    fun refreshQueries(changedTables: Set<String>) {
        for (entry in entries.values) if (entry.tables.any { it in changedTables }) {
            entry.rows = runQuery(entry.sql, entry.params)
            entry.listeners.values.toList().forEach { it() }
        }
    }

    fun refreshAll() = refreshQueries(schema.tableNames.toSet())

    fun <T> subscribe(query: Query<T>, listener: () -> Unit): () -> Unit {
        val entry = entryFor(query)
        val id = nextListenerId++
        entry.listeners[id] = listener
        val key = query.key
        return {
            entries[key]?.let {
                it.listeners.remove(id)
                if (it.listeners.isEmpty()) entries.remove(key)
            }
        }
    }
}
