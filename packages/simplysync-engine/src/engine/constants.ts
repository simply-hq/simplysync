// Engine-internal table names + the legacy-import version, shared by the store,
// relay, and lifecycle modules.

export const SYNC_OUTBOX_TABLE = "_sync_outbox";
export const SYNC_META_TABLE = "_sync_meta";
export const SYNC_SEEN_TABLE = "_sync_seen";

// Bumped when the legacy importer changes. Stored in _sync_meta as
// "legacyImported". After an explicit erase/restore we set it so the one-time
// legacy import does NOT resurrect the wiped data on the next boot.
export const LEGACY_IMPORT_VERSION = 3;
