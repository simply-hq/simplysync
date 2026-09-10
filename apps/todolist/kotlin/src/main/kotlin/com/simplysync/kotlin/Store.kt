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
        const val DEFERRED = "_sync_deferred"
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
            // Additive migration (parity with the TS engine): `create table if not
            // exists` is a no-op on an existing table, so a schema that has grown new
            // columns since the table was created would never get them. Add any missing
            // column — ALTER ADD COLUMN is metadata-only in SQLite and existing rows read
            // NULL until a write backfills them (which merges cleanly under LWW). Additive
            // only (no rename/drop) so old and new app versions stay wire-compatible.
            val present = driver.select("pragma table_info(\"$table\")")
                .mapNotNull { (it["name"] as? SqliteValue.Text)?.value }
                .toSet()
            for (name in columns.keys.sorted()) {
                if (name == "id" || name in present) continue
                driver.exec("alter table \"$table\" add column \"$name\" ${columns[name]!!.sqlite};")
            }
        }
        for (index in config.indexes) if (index.table.isNotEmpty() && index.columns.isNotEmpty()) {
            val cols = index.columns.joinToString(", ") { "\"$it\"" }
            driver.exec("create index if not exists \"${index.name}\" on \"${index.table}\" ($cols);")
        }
        driver.exec("create table if not exists \"$OUTBOX\" (event_id text primary key, envelope_json text not null, pushed_at text);")
        driver.exec("create table if not exists \"$SEEN\" (event_id text primary key);")
        driver.exec("create table if not exists \"$DEFERRED\" (event_id text primary key, payload_json text not null, retry_after_ms integer);")
        val deferredColumns = driver.select("pragma table_info(\"$DEFERRED\")")
            .mapNotNull { (it["name"] as? SqliteValue.Text)?.value }
            .toSet()
        if ("retry_after_ms" !in deferredColumns) {
            driver.exec("alter table \"$DEFERRED\" add column retry_after_ms integer;")
        }
        driver.exec(
            "create index if not exists \"${DEFERRED}_retry\" " +
                "on \"$DEFERRED\" (retry_after_ms, event_id);",
        )
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

    fun deleteMeta(key: String) {
        driver?.exec("delete from \"$META\" where key = ?", listOf(SqliteValue.Text(key)))
    }

    fun hasRelayHistory(): Boolean =
        driver?.select(
            "select 1 from \"$META\" " +
                "where key glob 'push:*' or key glob 'cursor:*' or key glob 'backfill:*' limit 1",
        )?.isNotEmpty() == true

    fun deferRemoteEvent(eventId: String, payloadJson: String, retryAfterMs: Long? = null) {
        driver?.exec(
            "insert or replace into \"$DEFERRED\" " +
                "(event_id, payload_json, retry_after_ms) values (?, ?, ?)",
            listOf(
                SqliteValue.Text(eventId),
                SqliteValue.Text(payloadJson),
                retryAfterMs?.let(SqliteValue::Integer) ?: SqliteValue.Null,
            ),
        )
    }

    fun opaqueDeferredEvents(afterEventId: String?, limit: Int): List<Pair<String, String>> {
        val driver = driver ?: return emptyList()
        val sql: String
        val args: List<SqliteValue>
        if (afterEventId == null) {
            sql = "select event_id, payload_json from \"$DEFERRED\" " +
                "where retry_after_ms is null order by event_id asc limit ?"
            args = listOf(SqliteValue.Integer(limit.toLong()))
        } else {
            sql = "select event_id, payload_json from \"$DEFERRED\" " +
                "where retry_after_ms is null and event_id > ? " +
                "order by event_id asc limit ?"
            args = listOf(SqliteValue.Text(afterEventId), SqliteValue.Integer(limit.toLong()))
        }
        return driver.select(sql, args).mapNotNull { row ->
            val eventId = (row["event_id"] as? SqliteValue.Text)?.value ?: return@mapNotNull null
            val payloadJson = (row["payload_json"] as? SqliteValue.Text)?.value ?: return@mapNotNull null
            eventId to payloadJson
        }
    }

    fun dueDeferredEvents(nowMs: Long, limit: Int): List<Pair<String, String>> = driver?.select(
        "select event_id, payload_json from \"$DEFERRED\" " +
            "where retry_after_ms is not null and retry_after_ms <= ? " +
            "order by retry_after_ms asc, event_id asc limit ?",
        listOf(SqliteValue.Integer(nowMs), SqliteValue.Integer(limit.toLong())),
    )?.mapNotNull { row ->
        val eventId = (row["event_id"] as? SqliteValue.Text)?.value ?: return@mapNotNull null
        val payloadJson = (row["payload_json"] as? SqliteValue.Text)?.value ?: return@mapNotNull null
        eventId to payloadJson
    } ?: emptyList()

    fun dropDeferredEvent(eventId: String) {
        driver?.exec(
            "delete from \"$DEFERRED\" where event_id = ?",
            listOf(SqliteValue.Text(eventId)),
        )
    }

    /**
     * Bound the outbox (a send queue, not an archive; parity with the TS engine):
     * drop events confirmed delivered to EVERY current relay. The lowest per-relay
     * push cursor (`push:<base>` in meta) is the highest event id every relay has
     * acked; events at or below it are fully delivered and safe to forget. A relay
     * with no cursor yet (just added) makes the minimum "" so nothing is pruned —
     * it still needs the backlog. Returns rows pruned.
     */
    fun pruneOutbox(relayBases: List<String>): Int {
        val driver = driver ?: return 0
        if (relayBases.isEmpty()) return 0
        val bound = relayBases.map { getMeta("push:$it") ?: "" }.minOrNull() ?: ""
        if (bound.isEmpty()) return 0
        val count = (
            driver.select(
                "select count(*) as c from \"$OUTBOX\" where event_id <= ?",
                listOf(SqliteValue.Text(bound)),
            ).firstOrNull()?.get("c") as? SqliteValue.Integer
            )?.value?.toInt() ?: 0
        if (count > 0) {
            driver.exec("delete from \"$OUTBOX\" where event_id <= ?", listOf(SqliteValue.Text(bound)))
            // A relay this device pushed to before but is not configured right now
            // could not have received what was just forgotten. Its push cursor
            // would otherwise vouch for it on re-add ("already seeded, skip the
            // backfill") and the relay would silently lack every event pruned
            // while it was away. Drop that vouching so re-adding it re-seeds; its
            // pull cursor stays — the relay's own log did not move.
            val remembered = driver.select("select key from \"$META\" where key glob 'push:*'")
                .mapNotNull { (it["key"] as? SqliteValue.Text)?.value?.removePrefix("push:") }
            for (base in remembered) {
                if (base in relayBases) continue
                deleteMeta("push:$base")
                deleteMeta("backfill:$base")
            }
        }
        return count
    }

    /**
     * Whether an event id already sits in the outbox. The write path asks this only
     * for caller-supplied HLCs; engine-minted ones are unique by construction.
     */
    fun hasQueuedEvent(eventId: String): Boolean =
        driver?.select(
            "select 1 from \"$OUTBOX\" where event_id = ?",
            listOf(SqliteValue.Text(eventId)),
        )?.isNotEmpty() == true

    /**
     * Reclaim local storage by hard-deleting soft-deleted rows (tombstones) older than
     * [olderThanMs] (parity with the TS engine). Safe: the grace window lets the deletion
     * replicate first; when [requirePushed] (relays configured), a tombstone whose delete
     * event is still pending in the outbox is kept; the relay retains tombstones so a
     * re-sync re-applies them — synced peers are never resurrected. Returns rows purged.
     */
    fun purgeDeleted(olderThanMs: Long, nowMs: Long, requirePushed: Boolean): Int {
        val driver = driver ?: return 0
        val cutoff = nowMs - olderThanMs
        var purged = 0
        for (table in schema.tableNames) {
            val rows = driver.select("select id, updatedAt from \"$table\" where isDeleted = 1")
            for (row in rows) {
                val id = (row["id"] as? SqliteValue.Text)?.value ?: continue
                val updatedAt = (row["updatedAt"] as? SqliteValue.Text)?.value ?: continue
                val millis = Hlc.parse(updatedAt)?.first ?: continue
                if (millis > cutoff) continue // too new -> keep
                if (requirePushed) {
                    val pending = driver.select(
                        "select 1 from \"$OUTBOX\" where event_id = ? and pushed_at is null limit 1",
                        listOf(SqliteValue.Text(updatedAt)),
                    )
                    if (pending.isNotEmpty()) continue // delete not yet on the relay -> keep
                }
                driver.exec("delete from \"$table\" where id = ?", listOf(SqliteValue.Text(id)))
                purged++
            }
        }
        return purged
    }

    fun wipeLocalData() {
        val driver = driver ?: return
        for (table in schema.tableNames) driver.exec("delete from \"$table\"")
        driver.exec("delete from \"$OUTBOX\"")
        driver.exec("delete from \"$SEEN\"")
        driver.exec("delete from \"$DEFERRED\"")
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

    /**
     * Project a remote payload onto the local schema. Unknown columns are
     * dropped for forward compatibility. A SQLite NULL in a non-null typed
     * column represents an omitted field, so leave it out instead of rejecting
     * the whole remote row.
     */
    fun projectRemoteRow(table: String, values: Map<String, JsonValue>): Pair<Map<String, JsonValue>, String?> {
        val row = LinkedHashMap<String, JsonValue>()
        for ((name, type) in schema.columns(table) ?: emptyMap()) {
            val value = values[name] ?: continue
            if (value is JsonValue.Null) {
                if (type.nullable) row[name] = JsonValue.Null
                continue
            }
            type.validate(value)?.let { return row to "$table.$name: $it" }
            row[name] = value
        }
        for (name in listOf("id", "createdAt", "updatedAt", "isDeleted")) {
            val value = values[name] ?: continue
            val message = when (name) {
                "id" -> if (value is JsonValue.Str && value.value.isNotEmpty()) null else "Expected a non-empty id string."
                "createdAt" -> if (value is JsonValue.Str) null else "Expected a string."
                "updatedAt" -> if (value is JsonValue.Str && Hlc.parse(value.value) != null) null else "Expected a valid SimplySync HLC."
                else -> if (value is JsonValue.IntVal && (value.value == 0L || value.value == 1L)) null else "Expected a SQLite boolean (0 or 1)."
            }
            if (message != null) return row to "$table.$name: $message"
            row[name] = value
        }
        return row to null
    }

    fun readRow(table: String, id: String): Map<String, SqliteValue>? =
        driver?.select("select * from \"$table\" where id = ?", listOf(SqliteValue.Text(id)))?.firstOrNull()
}
