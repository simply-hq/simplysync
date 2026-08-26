import Foundation

public enum HLCAdmissibility: Equatable {
    case admissible
    case future
    case malformed
}

public struct ParsedHLC: Equatable {
    public let millis: Int64
    public let counter: Int
    public let deviceId: String

    public init(millis: Int64, counter: Int, deviceId: String) {
        self.millis = millis
        self.counter = counter
        self.deviceId = deviceId
    }
}

/// Hybrid Logical Clock string, matching `createHlc` / `compareHlc`. Format:
/// `<millis base36, 10 chars>-<counter base36, 4 chars>-<deviceId>`, sortable as
/// a plain string.
public enum HLC {
    public static let maxFutureDriftMillis: Int64 = 5 * 60_000

    public static func make(deviceId: String, millis: Int64, counter: Int = 0) -> String {
        let time = pad(String(millis, radix: 36), to: 10)
        let count = pad(String(counter, radix: 36), to: 4)
        return "\(time)-\(count)-\(deviceId)"
    }

    /// Returns negative / 0 / positive by Unicode-scalar (code-unit) order,
    /// matching `@simplysync/protocol`'s `compareHlc`. A nil/empty left is
    /// always less (matches `if (!left) return -1`).
    public static func compare(_ left: String?, _ right: String) -> Int {
        guard let left, !left.isEmpty else { return -1 }
        if left == right { return 0 }
        return left < right ? -1 : 1
    }

    /// Strictly parse the canonical fixed-width representation.
    public static func parse(_ hlc: String) -> ParsedHLC? {
        let parts = hlc.split(separator: "-", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].utf8.count == 10,
              parts[1].utf8.count == 4,
              !parts[2].isEmpty,
              parts[0].utf8.allSatisfy(isLowerBase36),
              parts[1].utf8.allSatisfy(isLowerBase36),
              parts[2].utf8.allSatisfy(isDeviceIdByte),
              let millis = Int64(parts[0], radix: 36),
              let counter = Int(parts[1], radix: 36) else {
            return nil
        }
        return ParsedHLC(millis: millis, counter: counter, deviceId: String(parts[2]))
    }

    public static func admissibility(
        _ hlc: String,
        nowMillis: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        maxFutureDriftMillis: Int64 = HLC.maxFutureDriftMillis
    ) -> HLCAdmissibility {
        guard let parsed = parse(hlc) else { return .malformed }
        return parsed.millis > nowMillis + maxFutureDriftMillis ? .future : .admissible
    }

    private static func isLowerBase36(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (97...122).contains(byte)
    }

    private static func isDeviceIdByte(_ byte: UInt8) -> Bool {
        (48...57).contains(byte)
            || (65...90).contains(byte)
            || (97...122).contains(byte)
            || byte == 45
            || byte == 46
            || byte == 95
    }

    private static func pad(_ s: String, to width: Int) -> String {
        s.count >= width ? s : String(repeating: "0", count: width - s.count) + s
    }
}
