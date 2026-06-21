import Foundation
import Combine

/// Owns the engine's lifecycle for the demo: derive/persist an identity, build a
/// configured `SyncEngine`, and surface the owner. Mirrors how a real app wires
/// `createSync(deps)` once and keeps the engine for the app's lifetime.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var engine: SyncEngine?
    @Published private(set) var owner: AppOwner?
    @Published var errorMessage: String?
    @Published var relayURLString: String {
        didSet {
            defaults.set(relayURLString, forKey: relayURLKey)
            applyTransports()
        }
    }

    static let engineName = "simplysync"
    static let defaultRelayURL = "http://localhost:4100"

    private let secureStorage = KeychainStorage()
    private let defaults = UserDefaults.standard
    private let hasIdentityKey = "simplysync.hasIdentity"
    private let relayURLKey = "simplysync.relayURL"
    private var mnemonicKey: String { "\(Self.engineName):mnemonic" }

    init() {
        relayURLString = defaults.string(forKey: relayURLKey) ?? Self.defaultRelayURL
        if defaults.bool(forKey: hasIdentityKey) { makeEngine() }
    }

    /// Adopt a pasted `sf1_` key or 24-word phrase: validate, persist it as the
    /// engine's owner secret, then boot the engine on it.
    func configure(with recoveryKey: String) {
        do {
            let identity = try IdentityDeriver.derive(from: recoveryKey)
            secureStorage.setItem(mnemonicKey, identity.recoveryKey)
            defaults.set(true, forKey: hasIdentityKey)
            errorMessage = nil
            makeEngine()
        } catch {
            errorMessage = "Couldn't use that recovery key or phrase."
        }
    }

    /// Mint a brand-new identity (the engine generates a fresh `sf1_` key on boot).
    func generateNewIdentity() {
        secureStorage.removeItem(mnemonicKey)
        defaults.set(true, forKey: hasIdentityKey)
        errorMessage = nil
        makeEngine()
    }

    func signOut() {
        defaults.set(false, forKey: hasIdentityKey)
        engine = nil
        owner = nil
    }

    private func makeEngine() {
        let deps = SyncEngineDeps(
            makeDriver: { name in try SQLite3Driver(path: Self.dbPath(name)) },
            secureStorage: secureStorage,
            reloadApp: { [weak self] in Task { @MainActor in self?.refreshOwner() } })
        var config = SyncEngineConfig(name: Self.engineName, syncIntervalMs: 3000)
        if let transport = currentTransport() { config.transports = [transport] }
        let engine = createSync(deps)(appSchema, config)
        self.engine = engine
        Task { [weak self] in
            await engine.ready
            await MainActor.run { self?.refreshOwner() }
        }
    }

    private func refreshOwner() { owner = engine?.currentOwner }

    private func applyTransports() {
        guard let engine else { return }
        engine.setTransports(currentTransport().map { [$0] } ?? [])
    }

    private func currentTransport() -> Transport? {
        let trimmed = relayURLString.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: trimmed), url.scheme != nil else { return nil }
        return Transport(url: trimmed)
    }

    private static func dbPath(_ name: String) -> String {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("\(name).sqlite").path
    }
}
