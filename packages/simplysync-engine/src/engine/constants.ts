// Engine-internal table names + the legacy-import version, shared by the store,
// relay, and lifecycle modules.

export const SYNC_OUTBOX_TABLE = "_sync_outbox";
// Exact per-relay delivery acknowledgements for outbox rows. Push cursors are
// high-water marks and cannot prove that a lower-sorting cross-tab straggler
// reached a relay after its cursor advanced.
export const SYNC_OUTBOX_RELAY_TABLE = "_sync_outbox_relay";
export const SYNC_META_TABLE = "_sync_meta";
export const SYNC_SEEN_TABLE = "_sync_seen";
// Decrypted events for tables that this app version does not know yet. The
// relay cursor can advance while the payload remains durable for replay after
// an additive schema upgrade.
export const SYNC_DEFERRED_TABLE = "_sync_deferred";
// Device-local diagnostics: a bounded ring buffer of recent sync attempts so a
// consumer can show *why* and *when* sync failed (never synced to the relay).
export const SYNC_LOG_TABLE = "_sync_log";
export const SYNC_LOG_CAP = 200;
// Durable queue of purged rows whose relay streams still need compaction
// (`POST /v1/streams/compact`). Holds plaintext (table, rowId) — same trust
// level as the local row it replaces — because the streamId HMAC is async and
// must not run inside the (sync) purge transaction; it is derived at drain
// time in relay.ts. A row leaves the queue once every configured relay acks.
export const SYNC_PURGE_TABLE = "_sync_purge";
// Default age threshold for an explicit local-only purgeDeleted call. Synced
// tombstones are retained until the protocol has a cross-device delete
// watermark; an elapsed grace period alone cannot prove every device saw one.
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Bumped when the legacy importer changes. Stored in _sync_meta as
// "legacyImported". After an explicit erase/restore we set it so the one-time
// legacy import does NOT resurrect the wiped data on the next boot.
export const LEGACY_IMPORT_VERSION = 3;
