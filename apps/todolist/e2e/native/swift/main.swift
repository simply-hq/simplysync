import Foundation

private struct Device {
    let engine: SyncEngine
    let driver: SQLite3Driver
}

private final class TodoE2ERunner {
    private var devices: [String: Device] = [:]
    private let files = FileManager.default

    func loop(mailbox: URL, idleTimeoutMs: Double) {
        try? files.createDirectory(at: mailbox, withIntermediateDirectories: true)
        var processed = Set<String>()
        var lastActivity = Date()

        while true {
            let pending = pendingCommands(in: mailbox, processed: processed)
            if pending.isEmpty {
                if Date().timeIntervalSince(lastActivity) * 1000 > idleTimeoutMs { return }
                Thread.sleep(forTimeInterval: 0.025)
                continue
            }

            for commandFile in pending {
                processed.insert(commandFile.lastPathComponent)
                lastActivity = Date()
                let response = handle(commandFile)
                let name = commandFile.lastPathComponent.replacingOccurrences(
                    of: "cmd-",
                    with: "res-")
                writeAtomic(mailbox.appendingPathComponent(name), response)
                if response["_shutdown"] as? Bool == true { return }
            }
        }
    }

    private func pendingCommands(in mailbox: URL, processed: Set<String>) -> [URL] {
        let entries =
            (try? files.contentsOfDirectory(at: mailbox, includingPropertiesForKeys: nil)) ?? []
        return entries
            .filter {
                let name = $0.lastPathComponent
                return name.hasPrefix("cmd-")
                    && name.hasSuffix(".json")
                    && !processed.contains(name)
            }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private func handle(_ commandFile: URL) -> [String: Any] {
        guard
            let data = try? Data(contentsOf: commandFile),
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            return ["ok": false, "error": "unparseable command"]
        }

        let seq = object["seq"] as? Int ?? -1
        let command = object["cmd"] as? String ?? ""
        do {
            let result = try dispatch(command, object)
            var response: [String: Any] = ["seq": seq, "ok": true, "result": result]
            if command == "shutdown" { response["_shutdown"] = true }
            return response
        } catch {
            return ["seq": seq, "ok": false, "error": "\(error)"]
        }
    }

    private func dispatch(_ command: String, _ object: [String: Any]) throws -> Any {
        switch command {
        case "ping":
            return ["ready": true]

        case "init":
            let key = try string(object, "device")
            if devices[key] != nil { return ["initialized": true] }
            let recoveryKey = try string(object, "mnemonic")
            let deviceId = try string(object, "deviceId")
            let databasePath = try string(object, "dbPath")
            let storage = InMemorySecureStorage([
                "\(key):mnemonic": recoveryKey,
                "\(key):deviceId": deviceId,
            ])
            let driver = try SQLite3Driver(path: databasePath)
            let deps = SyncEngineDeps(
                makeDriver: { _ in driver },
                secureStorage: storage)
            let engine = createSync(deps)(
                appSchema,
                SyncEngineConfig(name: key, transports: []))
            try runBlocking {
                await engine.ready
                return ()
            }
            devices[key] = Device(engine: engine, driver: driver)
            return ["initialized": true]

        case "mutate":
            let device = try device(object)
            let table = try string(object, "table")
            let rowId = try string(object, "rowId")
            let result =
                object["op"] as? String == "delete"
                ? device.engine.delete(table, id: rowId)
                : device.engine.upsert(
                    table,
                    ["id": .string(rowId)]
                        .merging(jsonValues(object["values"])) { _, new in new })
            guard result.isOk else {
                throw RunnerError.mutation(result.errorMessage ?? "mutation failed")
            }
            return ["id": rowId]

        case "mutateMany":
            let device = try device(object)
            let operations = object["ops"] as? [[String: Any]] ?? []
            for operation in operations {
                let table = try string(operation, "table")
                let rowId = try string(operation, "rowId")
                let result =
                    operation["op"] as? String == "delete"
                    ? device.engine.delete(table, id: rowId)
                    : device.engine.upsert(
                        table,
                        ["id": .string(rowId)]
                            .merging(jsonValues(operation["values"])) { _, new in new })
                guard result.isOk else {
                    throw RunnerError.mutation(result.errorMessage ?? "mutation failed")
                }
            }
            return ["count": operations.count]

        case "sync":
            return try sync(try device(object), relayURL: try string(object, "relayUrl"))

        case "syncExpectError":
            let result = try syncState(
                try device(object),
                relayURL: try string(object, "relayUrl"))
            if case .notSynced(_, _, let status) = result {
                return ["threw": true, "kind": failureKind(status)]
            }
            return ["threw": false]

        case "owner":
            let device = try device(object)
            guard let owner = try runBlocking({ await device.engine.appOwner }) else {
                throw RunnerError.owner("Swift owner is not ready")
            }
            return ownerJSON(owner)

        case "restoreOwner":
            let device = try device(object)
            let recoveryKey = try string(object, "recoveryKey")
            device.engine.setTransports([Transport(url: try string(object, "relayUrl"))])
            defer { device.engine.setTransports([]) }
            try runBlocking {
                // setTransports starts a pass immediately. Finish that
                // old-owner pass before restore wipes and swaps identity.
                await device.engine.sync()
                try await device.engine.restoreAppOwner(recoveryKey)
                await device.engine.sync()
                return ()
            }
            if case .notSynced(let error, _, let status) = device.engine.getSyncState() {
                throw RunnerError.sync("\(failureKind(status)): \(error ?? "restore sync failed")")
            }
            guard let restored = try runBlocking({ await device.engine.appOwner }) else {
                throw RunnerError.owner("Swift owner is not ready after restore")
            }
            return ownerJSON(restored)

        case "outboxCount":
            return ["count": try outboxCount(try device(object).driver)]

        case "exportState":
            let rows = try device(object).driver.select(
                "select * from \"todo\" order by id")
            return ["todo": rows.map(rowToJSON)]

        case "purgeDeleted":
            let device = try device(object)
            let olderThanMs = (object["olderThanMs"] as? NSNumber)?.int64Value ?? 0
            return ["purged": device.engine.purgeDeleted(olderThanMs: olderThanMs)]

        case "dispose":
            let key = try string(object, "device")
            guard let device = devices.removeValue(forKey: key) else {
                throw RunnerError.unknownDevice(key)
            }
            device.engine.setTransports([])
            return ["disposed": true]

        case "shutdown":
            for device in devices.values { device.engine.setTransports([]) }
            devices.removeAll()
            return ["stopped": true]

        default:
            throw RunnerError.badCommand(command)
        }
    }

    private func sync(_ device: Device, relayURL: String) throws -> [String: Int] {
        let beforeOutbox = try outboxCount(device.driver)
        let beforeRows = try rowCount(device.driver)
        let state = try syncState(device, relayURL: relayURL)
        if case .notSynced(let error, _, let status) = state {
            throw RunnerError.sync("\(failureKind(status)): \(error ?? "sync failed")")
        }
        let afterOutbox = try outboxCount(device.driver)
        let afterRows = try rowCount(device.driver)
        return [
            "pushed": max(0, beforeOutbox - afterOutbox),
            "pulled": max(0, afterRows - beforeRows),
            "applied": max(0, afterRows - beforeRows),
        ]
    }

    private func syncState(_ device: Device, relayURL: String) throws -> SyncState {
        device.engine.setTransports([Transport(url: relayURL)])
        try runBlocking {
            await device.engine.sync()
            return ()
        }
        let state = device.engine.getSyncState()
        device.engine.setTransports([])
        return state
    }

    private func outboxCount(_ driver: SQLite3Driver) throws -> Int {
        let row = try driver.select(
            "select count(*) as count from \"_sync_outbox\"").first
        if case .integer(let count)? = row?["count"] { return Int(count) }
        return 0
    }

    private func rowCount(_ driver: SQLite3Driver) throws -> Int {
        let row = try driver.select("select count(*) as count from \"todo\"").first
        if case .integer(let count)? = row?["count"] { return Int(count) }
        return 0
    }

    private func ownerJSON(_ owner: AppOwner) -> [String: Any] {
        ["id": owner.id, "recoveryKey": owner.recoveryKey]
    }

    private func device(_ object: [String: Any]) throws -> Device {
        let key = try string(object, "device")
        guard let device = devices[key] else { throw RunnerError.unknownDevice(key) }
        return device
    }

    private func string(_ object: [String: Any], _ key: String) throws -> String {
        guard let value = object[key] as? String else {
            throw RunnerError.missingField(key)
        }
        return value
    }

    private func jsonValues(_ any: Any?) -> [String: JSONValue] {
        guard let object = any as? [String: Any] else { return [:] }
        return object.mapValues(jsonValue)
    }

    private func jsonValue(_ any: Any) -> JSONValue {
        if any is NSNull { return .null }
        if let string = any as? String { return .string(string) }
        if let number = any as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                return .bool(number.boolValue)
            }
            let double = number.doubleValue
            if double == double.rounded(), abs(double) < 9e15 {
                return .int(number.intValue)
            }
            return .double(double)
        }
        if let array = any as? [Any] { return .array(array.map(jsonValue)) }
        if let object = any as? [String: Any] {
            return .object(object.mapValues(jsonValue))
        }
        return .string("\(any)")
    }

    private func rowToJSON(_ row: SQLiteRow) -> [String: Any] {
        row.mapValues { value in
            switch value {
            case .text(let string): return string
            case .integer(let integer): return NSNumber(value: integer)
            case .real(let double): return double
            case .blob(let data): return data.base64EncodedString()
            case .null: return NSNull()
            }
        }
    }

    private func failureKind(_ status: Int?) -> String {
        guard let status else { return "unreachable" }
        switch status {
        case 401, 403: return "authRejected"
        case 413: return "quotaExceeded"
        case 429: return "rateLimited"
        case 500...: return "serverError"
        case 400...: return "badRequest"
        default: return "unknown"
        }
    }

    private func writeAtomic(_ destination: URL, _ body: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        let temporary = destination
            .deletingLastPathComponent()
            .appendingPathComponent(destination.lastPathComponent + ".tmp")
        try? data.write(to: temporary)
        try? files.removeItem(at: destination)
        try? files.moveItem(at: temporary, to: destination)
    }
}

private enum RunnerError: Error, CustomStringConvertible {
    case badCommand(String)
    case missingField(String)
    case mutation(String)
    case sync(String)
    case owner(String)
    case unknownDevice(String)

    var description: String {
        switch self {
        case .badCommand(let command): return "unknown command '\(command)'"
        case .missingField(let field): return "missing field '\(field)'"
        case .mutation(let message): return message
        case .sync(let message): return message
        case .owner(let message): return message
        case .unknownDevice(let device): return "unknown device '\(device)'"
        }
    }
}

private func runBlocking<T>(
    _ operation: @escaping () async throws -> T
) throws -> T {
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox<T>()
    Task {
        do { box.result = .success(try await operation()) }
        catch { box.result = .failure(error) }
        semaphore.signal()
    }
    semaphore.wait()
    return try box.result!.get()
}

private final class ResultBox<T>: @unchecked Sendable {
    var result: Result<T, Error>?
}

guard let mailboxPath = ProcessInfo.processInfo.environment[
    "SIMPLYSYNC_TODO_E2E_MAILBOX"
] else {
    FileHandle.standardError.write(
        Data("TodoList Swift E2E runner: mailbox is required\n".utf8))
    exit(1)
}
let idleTimeoutMs = ProcessInfo.processInfo.environment[
    "SIMPLYSYNC_TODO_E2E_IDLE_TIMEOUT_MS"
].flatMap(Double.init) ?? 120_000

TodoE2ERunner().loop(
    mailbox: URL(fileURLWithPath: mailboxPath),
    idleTimeoutMs: idleTimeoutMs)
