import Foundation

/// Hybrid Logical Clock string, matching `createHlc` / `compareHlc`. Format:
/// `<millis base36, 10 chars>-<counter base36, 4 chars>-<deviceId>`, sortable as
/// a plain string.
enum HLC {
    static func make(deviceId: String, millis: Int64, counter: Int = 0) -> String {
        let time = pad(String(millis, radix: 36), to: 10)
        let count = pad(String(counter, radix: 36), to: 4)
        return "\(time)-\(count)-\(deviceId)"
    }

    /// Returns negative / 0 / positive by Unicode-scalar (code-unit) order,
    /// matching `@simplysync/protocol`'s `compareHlc`. A nil/empty left is
    /// always less (matches `if (!left) return -1`).
    static func compare(_ left: String?, _ right: String) -> Int {
        guard let left, !left.isEmpty else { return -1 }
        if left == right { return 0 }
        return left < right ? -1 : 1
    }

    private static func pad(_ s: String, to width: Int) -> String {
        s.count >= width ? s : String(repeating: "0", count: width - s.count) + s
    }
}

/// A monotonic clock that never emits a duplicate HLC for this device, bumping
/// the counter when the wall clock doesn't advance.
final class HLCClock {
    private let deviceId: String
    private var lastMillis: Int64 = 0
    private var counter: Int = 0

    init(deviceId: String) { self.deviceId = deviceId }

    func next() -> String {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if now > lastMillis {
            lastMillis = now
            counter = 0
        } else {
            counter += 1
        }
        return HLC.make(deviceId: deviceId, millis: lastMillis, counter: counter)
    }
}
