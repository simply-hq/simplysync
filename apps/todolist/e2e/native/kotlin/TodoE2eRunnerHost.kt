package com.simplysync.kotlin.e2e

import com.simplysync.kotlin.Column
import com.simplysync.kotlin.InMemorySecureStorage
import com.simplysync.kotlin.JdbcSqliteDriver
import com.simplysync.kotlin.JsonValue
import com.simplysync.kotlin.MutationResult
import com.simplysync.kotlin.Schema
import com.simplysync.kotlin.SqliteValue
import com.simplysync.kotlin.SyncEngine
import com.simplysync.kotlin.SyncEngineConfig
import com.simplysync.kotlin.SyncEngineDeps
import com.simplysync.kotlin.SyncState
import com.simplysync.kotlin.Transport
import com.simplysync.kotlin.createSync
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.junit.Assume
import org.junit.Test

/**
 * Long-lived mailbox host used by `apps/todolist/e2e`. It exercises the local
 * Kotlin TodoList schema and production SyncEngine directly.
 */
class TodoE2eRunnerHost {
    private data class Device(
        val engine: SyncEngine,
        val driver: JdbcSqliteDriver,
    )

    private val schema = Schema(
        mapOf(
            "todo" to mapOf(
                "id" to Column.id("todo"),
                "title" to Column.nonEmptyString,
                "done" to Column.sqliteBoolean,
            ),
        ),
    )
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val devices = HashMap<String, Device>()

    @Test
    fun run() {
        val mailboxPath = System.getProperty("todolistE2eMailbox")
        Assume.assumeTrue(
            "TodoList E2E runner disabled (no todolistE2eMailbox)",
            mailboxPath != null,
        )
        val mailbox = File(mailboxPath!!).apply { mkdirs() }
        val idleTimeoutMs =
            System.getProperty("todolistE2eIdleTimeoutMs")?.toLongOrNull() ?: 120_000L
        loop(mailbox, idleTimeoutMs)
    }

    private fun loop(mailbox: File, idleTimeoutMs: Long) {
        val processed = HashSet<String>()
        var lastActivity = System.currentTimeMillis()
        while (true) {
            val pending = mailbox.listFiles { file ->
                file.isFile &&
                    file.name.startsWith("cmd-") &&
                    file.name.endsWith(".json") &&
                    file.name !in processed
            }?.sortedBy { it.name } ?: emptyList()

            if (pending.isEmpty()) {
                if (System.currentTimeMillis() - lastActivity > idleTimeoutMs) return
                Thread.sleep(25)
                continue
            }

            for (commandFile in pending) {
                processed.add(commandFile.name)
                lastActivity = System.currentTimeMillis()
                val response = handle(commandFile)
                writeAtomic(
                    File(mailbox, commandFile.name.replaceFirst("cmd-", "res-")),
                    response,
                )
                if (response["_shutdown"]?.jsonPrimitive?.booleanOrNull == true) return
            }
        }
    }

    private fun handle(commandFile: File): JsonObject {
        val objectValue = try {
            json.parseToJsonElement(commandFile.readText()).jsonObject
        } catch (error: Throwable) {
            return buildJsonObject {
                put("ok", false)
                put("error", "unparseable command: ${error.message}")
            }
        }
        val seq = objectValue["seq"]?.jsonPrimitive?.int ?: -1
        val command = objectValue["cmd"]?.jsonPrimitive?.content ?: ""
        return try {
            val result = dispatch(command, objectValue)
            buildJsonObject {
                put("seq", seq)
                put("ok", true)
                put("result", result)
                if (command == "shutdown") put("_shutdown", true)
            }
        } catch (error: Throwable) {
            buildJsonObject {
                put("seq", seq)
                put("ok", false)
                put("error", error.message ?: error.toString())
            }
        }
    }

    private fun dispatch(command: String, objectValue: JsonObject): JsonElement = when (command) {
        "ping" -> buildJsonObject { put("ready", true) }

        "init" -> {
            val key = objectValue.string("device")
            if (devices[key] == null) {
                val storage = InMemorySecureStorage(
                    mapOf(
                        "$key:mnemonic" to objectValue.string("mnemonic"),
                        "$key:deviceId" to objectValue.string("deviceId"),
                    ),
                )
                val driver = JdbcSqliteDriver(objectValue.string("dbPath"))
                val engine = createSync(
                    SyncEngineDeps(
                        makeDriver = { driver },
                        secureStorage = storage,
                    ),
                )(schema, SyncEngineConfig(name = key, transports = emptyList()))
                runBlocking { engine.ready() }
                devices[key] = Device(engine, driver)
            }
            buildJsonObject { put("initialized", true) }
        }

        "mutate" -> {
            val device = device(objectValue)
            val table = objectValue.string("table")
            val rowId = objectValue.string("rowId")
            val result = if (objectValue.stringOr("op", "upsert") == "delete") {
                device.engine.delete(table, rowId)
            } else {
                val pairs = buildList<Pair<String, Any?>> {
                    add("id" to rowId)
                    values(objectValue).forEach { (key, value) -> add(key to value) }
                }
                device.engine.upsert(table, *pairs.toTypedArray())
            }
            requireMutation(result)
            buildJsonObject { put("id", rowId) }
        }

        "mutateMany" -> {
            val device = device(objectValue)
            val operations = objectValue["ops"]?.let { it as? JsonArray } ?: JsonArray(emptyList())
            for (element in operations) {
                val operation = element.jsonObject
                val table = operation.string("table")
                val rowId = operation.string("rowId")
                val result = if (operation.stringOr("op", "upsert") == "delete") {
                    device.engine.delete(table, rowId)
                } else {
                    val pairs = buildList<Pair<String, Any?>> {
                        add("id" to rowId)
                        values(operation).forEach { (key, value) -> add(key to value) }
                    }
                    device.engine.upsert(table, *pairs.toTypedArray())
                }
                requireMutation(result)
            }
            buildJsonObject { put("count", operations.size) }
        }

        "sync" -> {
            val device = device(objectValue)
            val beforeOutbox = outboxCount(device)
            val beforeRows = rowCount(device)
            val state = syncState(device, objectValue.string("relayUrl"))
            if (state is SyncState.NotSynced) {
                error("${failureKind(state.status)}: ${state.error ?: "sync failed"}")
            }
            val afterOutbox = outboxCount(device)
            val afterRows = rowCount(device)
            buildJsonObject {
                put("pushed", (beforeOutbox - afterOutbox).coerceAtLeast(0))
                put("pulled", (afterRows - beforeRows).coerceAtLeast(0))
                put("applied", (afterRows - beforeRows).coerceAtLeast(0))
            }
        }

        "syncExpectError" -> {
            val state = syncState(device(objectValue), objectValue.string("relayUrl"))
            if (state is SyncState.NotSynced) {
                buildJsonObject {
                    put("threw", true)
                    put("kind", failureKind(state.status))
                }
            } else {
                buildJsonObject { put("threw", false) }
            }
        }

        "owner" -> ownerJson(
            runBlocking { device(objectValue).engine.appOwner() }
                ?: error("Kotlin owner is not ready"),
        )

        "restoreOwner" -> {
            val device = device(objectValue)
            device.engine.setTransports(listOf(Transport(objectValue.string("relayUrl"))))
            try {
                runBlocking {
                    // setTransports starts a pass immediately. Finish that
                    // old-owner pass before restore wipes and swaps identity.
                    device.engine.sync()
                    device.engine.restoreAppOwner(objectValue.string("recoveryKey"))
                    device.engine.sync()
                }
                val state = device.engine.getSyncState()
                if (state is SyncState.NotSynced) {
                    error("${failureKind(state.status)}: ${state.error ?: "restore sync failed"}")
                }
                ownerJson(
                    runBlocking { device.engine.appOwner() }
                        ?: error("Kotlin owner is not ready after restore"),
                )
            } finally {
                device.engine.setTransports(emptyList())
            }
        }

        "outboxCount" -> buildJsonObject {
            put("count", outboxCount(device(objectValue)))
        }

        "exportState" -> {
            val rows = device(objectValue).driver.select(
                "select * from \"todo\" order by id",
            )
            buildJsonObject {
                put("todo", buildJsonArray {
                    rows.forEach { add(rowToJson(it)) }
                })
            }
        }

        "purgeDeleted" -> {
            val device = device(objectValue)
            val olderThanMs =
                objectValue["olderThanMs"]?.jsonPrimitive?.longOrNull ?: 0L
            buildJsonObject { put("purged", device.engine.purgeDeleted(olderThanMs)) }
        }

        "dispose" -> {
            val key = objectValue.string("device")
            val device = devices.remove(key) ?: error("unknown Kotlin TodoList device '$key'")
            device.engine.close()
            buildJsonObject { put("disposed", true) }
        }

        "shutdown" -> {
            devices.values.forEach { it.engine.close() }
            devices.clear()
            buildJsonObject { put("stopped", true) }
        }

        else -> error("unknown TodoList E2E command '$command'")
    }

    private fun syncState(device: Device, relayUrl: String): SyncState {
        device.engine.setTransports(listOf(Transport(relayUrl)))
        runBlocking { device.engine.sync() }
        val state = device.engine.getSyncState()
        device.engine.setTransports(emptyList())
        return state
    }

    private fun outboxCount(device: Device): Int =
        (device.driver.select("select count(*) as count from \"_sync_outbox\"")
            .firstOrNull()
            ?.get("count") as? SqliteValue.Integer)
            ?.value
            ?.toInt() ?: 0

    private fun rowCount(device: Device): Int =
        (device.driver.select("select count(*) as count from \"todo\"")
            .firstOrNull()
            ?.get("count") as? SqliteValue.Integer)
            ?.value
            ?.toInt() ?: 0

    private fun ownerJson(owner: com.simplysync.kotlin.AppOwner): JsonObject =
        buildJsonObject {
            put("id", owner.id)
            put("recoveryKey", owner.recoveryKey)
        }

    private fun device(objectValue: JsonObject): Device {
        val key = objectValue.string("device")
        return devices[key] ?: error("unknown Kotlin TodoList device '$key'")
    }

    private fun requireMutation(result: MutationResult) {
        if (!result.isOk) error(result.errorMessage ?: "mutation failed")
    }

    private fun values(objectValue: JsonObject): Map<String, JsonValue> =
        (objectValue["values"] as? JsonObject)
            ?.mapValues { toJsonValue(it.value) }
            ?: emptyMap()

    private fun toJsonValue(element: JsonElement): JsonValue = when (element) {
        is JsonNull -> JsonValue.Null
        is JsonArray -> JsonValue.Arr(element.map(::toJsonValue))
        is JsonObject -> JsonValue.Obj(element.mapValues { toJsonValue(it.value) })
        is JsonPrimitive ->
            if (element.isString) JsonValue.Str(element.content)
            else element.booleanOrNull?.let { JsonValue.Bool(it) }
                ?: element.longOrNull?.let { JsonValue.IntVal(it) }
                ?: element.doubleOrNull?.let { JsonValue.DoubleVal(it) }
                ?: JsonValue.Str(element.content)
    }

    private fun rowToJson(row: Map<String, SqliteValue>): JsonObject = buildJsonObject {
        for ((key, value) in row) {
            put(
                key,
                when (value) {
                    is SqliteValue.Text -> JsonPrimitive(value.value)
                    is SqliteValue.Integer -> JsonPrimitive(value.value)
                    is SqliteValue.Real -> JsonPrimitive(value.value)
                    is SqliteValue.Blob -> JsonPrimitive(
                        java.util.Base64.getEncoder().encodeToString(value.value),
                    )
                    SqliteValue.Null -> JsonNull
                },
            )
        }
    }

    private fun failureKind(status: Int?): String = when (status) {
        null -> "unreachable"
        401, 403 -> "authRejected"
        413 -> "quotaExceeded"
        429 -> "rateLimited"
        in 500..599 -> "serverError"
        in 400..499 -> "badRequest"
        else -> "unknown"
    }

    private fun writeAtomic(destination: File, body: JsonObject) {
        val temporary = File(destination.parentFile, destination.name + ".tmp")
        temporary.writeText(json.encodeToString(JsonObject.serializer(), body))
        Files.move(
            temporary.toPath(),
            destination.toPath(),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING,
        )
    }

    private fun JsonObject.string(key: String): String =
        this[key]?.jsonPrimitive?.content ?: error("missing field '$key'")

    private fun JsonObject.stringOr(key: String, default: String): String =
        this[key]?.jsonPrimitive?.content ?: default
}
