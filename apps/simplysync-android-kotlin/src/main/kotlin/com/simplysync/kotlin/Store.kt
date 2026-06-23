package com.simplysync.kotlin

/**
 * The local SQLite layer — the Kotlin port of the engine's store: physical schema
 * creation (with the system columns every row carries), the `_sync_*` tables, the
 * `_sync_meta` key/value store, row upserts, and value coercion against the typed
 * schema. Not internally locked — the engine serializes all access.
 */
class Store(private val schema: Schema, private val config: SyncEngineConfig) {
    companion object {
        const val OUTBOX = "_sync_outbox"
        const val SEEN = "_sync_seen"
        const val META = "_sync_meta"
    }

    var driver: SqliteDriver? = null

    /** Creates one physical table per schema entry plus the sync bookkeeping tables. */
    fun ensureSchema() {
        val driver = driver ?: return
        driver.exec("pragma journal_mode = WAL;")
        for (table in schema.tableNames) {
            val columns = schema.columns(table) ?: emptyMap()
            val defs = mutableListOf("\"id\" text primary key")
            for (name in columns.keys.sorted()) if (name != "id") defs.add("\"$name\" ${columns[name]!!.sqlite}")
            defs.add("\"createdAt\" text")
            defs.add("\"updatedAt\" text")
            defs.add("\"isDeleted\" integer default 0")
            driver.exec("create table if not exists \"$table\" (${defs.joinToString(", ")});")
        }
        for (index in config.indexes) if (index.table.isNotEmpty() && index.columns.isNotEmpty()) {
            val cols = index.columns.joinToString(", ") { "\"$it\"" }
            driver.exec("create index if not exists \"${index.name}\" on \"${index.table}\" ($cols);")
        }
        driver.exec("create table if not exists \"$OUTBOX\" (event_id text primary key, envelope_json text not null, pushed_at text);")
        driver.exec("create table if not exists \"$SEEN\" (event_id text primary key);")
        driver.exec("create table if not exists \"$META\" (key text primary key, value text not null);")
    }

    fun getMeta(key: String): String? {
        val rows = driver?.select("select value from \"$META\" where key = ?", listOf(SqliteValue.Text(key))) ?: return null
        return (rows.firstOrNull()?.get("value") as? SqliteValue.Text)?.value
    }

    fun setMeta(key: String, value: String) {
        driver?.exec(
            "insert into \"$META\" (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
            listOf(SqliteValue.Text(key), SqliteValue.Text(value)),
        )
    }

    fun wipeLocalData() {
        val driver = driver ?: return
        for (table in schema.tableNames) driver.exec("delete from \"$table\"")
        driver.exec("delete from \"$OUTBOX\"")
        driver.exec("delete from \"$SEEN\"")
        driver.exec("delete from \"$META\"")
    }

    /** Upsert a full row (`insert … on conflict(id) do update`). */
    fun writeRow(table: String, row: Map<String, JsonValue>) {
        val driver = driver ?: return
        val keys = row.keys.toList()
        val cols = keys.joinToString(", ") { "\"$it\"" }
        val placeholders = keys.joinToString(", ") { "?" }
        val updates = keys.filter { it != "id" }.joinToString(", ") { "\"$it\" = excluded.\"$it\"" }
        driver.exec(
            "insert into \"$table\" ($cols) values ($placeholders) on conflict(\"id\") do update set $updates",
            keys.map { row[it]!!.toSqlite() },
        )
    }

    /** Validate + collect the columns present in `values`; first error wins. */
    fun coerceValues(table: String, values: Map<String, JsonValue>): Pair<Map<String, JsonValue>, String?> {
        val row = LinkedHashMap<String, JsonValue>()
        for ((name, type) in schema.columns(table) ?: emptyMap()) {
            val value = values[name] ?: continue
            if (value is JsonValue.Null) {
                if (type.nullable) { row[name] = JsonValue.Null; continue }
                return row to "$table.$name: ${type.name} must not be null."
            }
            type.validate(value)?.let { return row to "$table.$name: $it" }
            row[name] = value
        }
        return row to null
    }

    fun readRow(table: String, id: String): Map<String, SqliteValue>? =
        driver?.select("select * from \"$table\" where id = ?", listOf(SqliteValue.Text(id)))?.firstOrNull()
}
