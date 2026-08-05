import Foundation
import Security

/// Stores the recovery phrase in the OS secret store — the Swift port of the
/// engine's `SecureStorage` (the role `expo-secure-store` plays on RN). Kept
/// synchronous since the Keychain API is.
public protocol SecureStorage: AnyObject {
    func getItem(_ key: String) -> String?
    func setItem(_ key: String, _ value: String)
    func removeItem(_ key: String)
}

/// Keychain-backed secure storage (the default for the iOS/macOS app). Items are
/// `kSecClassGenericPassword`, scoped to one service.
public final class KeychainStorage: SecureStorage {
    private let service: String

    public init(service: String = "dev.simplysync.engine") { self.service = service }

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }

    public func getItem(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func setItem(_ key: String, _ value: String) {
        let data = Data(value.utf8)
        SecItemDelete(query(key) as CFDictionary)
        var q = query(key)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }

    public func removeItem(_ key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }
}

/// A process-memory secure store — used by the host tests (and any context where
/// the Keychain isn't available). Thread-safe.
public final class InMemorySecureStorage: SecureStorage {
    private var items: [String: String] = [:]
    private let lock = NSLock()

    public init(_ seed: [String: String] = [:]) { items = seed }

    public func getItem(_ key: String) -> String? { lock.withLock { items[key] } }
    public func setItem(_ key: String, _ value: String) { lock.withLock { items[key] = value } }
    public func removeItem(_ key: String) { lock.withLock { items[key] = nil } }
}
