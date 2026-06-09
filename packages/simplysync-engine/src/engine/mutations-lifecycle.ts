import {
  base64UrlEncode,
  createMnemonic,
  decryptStringWithKey,
  decryptStringWithPassphrase,
  deriveBackupKeyBytes,
  deriveIdentity,
  encryptPayload,
  encryptStringWithKey,
  encryptStringWithPassphrase,
  InvalidBackupEnvelopeError,
  isEncryptedEnvelope,
  isRecoveryMnemonic,
  normalizeMnemonic,
  type EncryptedEnvelopeV1,
  type LocalFirstIdentity,
  type SyncPayload,
} from "@simplysync/protocol";
import {
  sqliteFalse,
  type Id,
  type SqliteBoolean,
} from "../type";
import type {
  DbSnapshot,
  MutationOptions,
  MutationResult,
  SchemaDefinition,
  SyncEngineConfig,
  SyncEngineDeps,
} from "../engine-types";
import { LEGACY_IMPORT_VERSION, SYNC_OUTBOX_TABLE } from "./constants";
import { createId } from "./ids";
import type { QueryCache } from "./query-cache";
import type { RelaySync } from "./relay";
import type { EngineState } from "./state";
import type { Clock, Store } from "./store";

export type Mutations = ReturnType<typeof createMutations>;

/**
 * The local write path. `mutate` validates + merges a row, stamps the HLC,
 * writes it in a transaction, queues an encrypted event in the outbox, then
 * opportunistically syncs. `insert`/`update`/`upsert` are the three modes.
 */
export function createMutations(
  state: EngineState,
  store: Store,
  clock: Clock,
  queryCache: QueryCache,
  relay: RelaySync,
  schema: SchemaDefinition,
) {
  const enqueue = async (
    table: string,
    op: SyncPayload["op"],
    rowId: string,
    hlc: string,
    value: unknown,
  ): Promise<void> => {
    const { identity, driver } = state;
    if (!identity || !driver) return;
    const envelope = await encryptPayload(
      identity,
      { eventId: hlc, deviceId: state.deviceId },
      { schemaVersion: 1, table, op, rowId, hlc, value },
    );
    driver.exec(
      `insert or ignore into "${SYNC_OUTBOX_TABLE}" (event_id, envelope_json) values (?, ?)`,
      [hlc, JSON.stringify(envelope)],
    );
  };

  const mutate = (
    table: string,
    values: Record<string, unknown>,
    mode: "insert" | "update" | "upsert",
    options?: MutationOptions,
  ): MutationResult => {
    const { driver } = state;
    if (!driver)
      return { ok: false, error: { message: "Database not ready." } };
    if (!(table in schema))
      return { ok: false, error: { message: `Unknown table: ${table}` } };

    const id = (values.id as Id | undefined) ?? createId();
    const existing =
      mode === "insert"
        ? null
        : driver.select<Record<string, unknown>>(
            `select * from "${table}" where id = ?`,
            [id],
          )[0] ?? null;

    if (mode === "update" && !existing)
      return { ok: false, error: { message: `Row not found: ${id}` } };

    const { row, error: coerceError } = store.coerceValues(table, {
      ...values,
      id,
    });
    if (coerceError) return { ok: false, error: { message: coerceError } };

    if ("isDeleted" in values) row.isDeleted = values.isDeleted;

    const hlc = clock.nextHlc();
    const providedCreatedAt =
      typeof values.createdAt === "string" ? values.createdAt : undefined;
    const merged: Record<string, unknown> = {
      ...(existing ?? {}),
      ...row,
      id,
      updatedAt: hlc,
      // Keep the existing createdAt on update; allow callers (demo data, legacy
      // import) to backfill a date-appropriate createdAt on insert; otherwise
      // stamp now.
      createdAt:
        (existing?.createdAt as string | undefined) ??
        providedCreatedAt ??
        new Date().toISOString(),
      isDeleted:
        (row.isDeleted as SqliteBoolean | undefined) ??
        (existing?.isDeleted as SqliteBoolean | undefined) ??
        sqliteFalse,
    };

    try {
      driver.transaction(() => {
        store.writeRow(table, merged);
      });
    } catch (caught) {
      return {
        ok: false,
        error: {
          message: caught instanceof Error ? caught.message : String(caught),
        },
      };
    }

    void enqueue(table, "upsert", id, hlc, merged).then(() => {
      // best-effort opportunistic sync after a local write
      if (state.transports.length > 0) void relay.sync().catch(() => undefined);
    });
    queryCache.refreshQueries([table]);
    options?.onComplete?.();
    return { ok: true, value: { id } };
  };

  return { mutate, enqueue };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;

/**
 * Boot + owner management: derive/persist the identity and device id, open the
 * DB and create the schema (`init`), the one-time legacy importer, and the
 * restore/reset owner flows (which wipe local data and adopt a new identity).
 */
export function createLifecycle(
  state: EngineState,
  store: Store,
  queryCache: QueryCache,
  relay: RelaySync,
  mutations: Mutations,
  schema: SchemaDefinition,
  deps: SyncEngineDeps,
  config: SyncEngineConfig,
  fetchImpl: typeof fetch,
) {
  const mnemonicKey = `${config.name}:mnemonic`;
  const deviceKey = `${config.name}:deviceId`;

  const loadIdentity = async (): Promise<void> => {
    let mnemonic =
      config.externalAppOwner?.mnemonic ??
      (await deps.secureStorage.getItem(mnemonicKey));
    if (!mnemonic || !isRecoveryMnemonic(mnemonic)) {
      mnemonic = createMnemonic();
      await deps.secureStorage.setItem(mnemonicKey, mnemonic);
    }
    mnemonic = normalizeMnemonic(mnemonic);
    state.identity = await deriveIdentity(mnemonic);
    state.appOwnerValue = {
      id: state.identity.ownerId,
      mnemonic,
      writeKey: state.identity.relayAuth,
    };
    let storedDevice = await deps.secureStorage.getItem(deviceKey);
    if (!storedDevice) {
      const bytes = new Uint8Array(8);
      globalThis.crypto.getRandomValues(bytes);
      storedDevice = base64UrlEncode(bytes);
      await deps.secureStorage.setItem(deviceKey, storedDevice);
    }
    state.deviceId = storedDevice;
  };

  // Switch to a different owner (restore an existing phrase, or reset to a fresh
  // one): persist the phrase, wipe local data, adopt the new identity, and
  // re-point the cached appOwner promise. Marks the one-time legacy import as
  // done so the post-reload boot doesn't resurrect the wiped legacy db. Callers
  // handle reload (and any post-switch sync) themselves.
  const switchOwner = async (
    mnemonic: string,
    derived: LocalFirstIdentity,
  ): Promise<void> => {
    await deps.secureStorage.setItem(mnemonicKey, mnemonic);
    store.wipeLocalData();
    store.setMeta("legacyImported", String(LEGACY_IMPORT_VERSION));
    state.identity = derived;
    state.appOwnerValue = {
      id: derived.ownerId,
      mnemonic,
      writeKey: derived.relayAuth,
    };
    state.appOwnerPromise = Promise.resolve(state.appOwnerValue);
    queryCache.refreshQueries(Object.keys(schema));
  };

  const init = async (): Promise<void> => {
    try {
      // Open the DB and derive identity while `driver` is still null, so any
      // query that renders during these awaits safely returns []. Only expose
      // the driver after the schema exists — assignment + ensureSchema are
      // synchronous and adjacent, so no query can run against missing tables.
      const sqlite = await deps.createSqliteDriver(config.name);
      await loadIdentity();
      state.driver = sqlite;
      store.ensureSchema();
      state.schemaReady = true;
      // Seed the HLC clock from its persisted high-water mark so it stays
      // monotonic across restarts (see createClock).
      state.hlcTime = Number(store.getMeta("hlc:time") ?? "0") || 0;
      state.hlcCounter = Number(store.getMeta("hlc:counter") ?? "0") || 0;
      // hydrate any active queries created before init finished
      queryCache.refreshQueries(Object.keys(schema));
      if (state.transports.length > 0) {
        void relay.sync().catch(() => undefined);
        relay.startPolling();
      }
      // Sync promptly when the app regains focus / connectivity (web).
      const target = globalThis as unknown as {
        addEventListener?: (t: string, cb: () => void) => void;
      };
      if (typeof target.addEventListener === "function") {
        const onActive = () => {
          if (state.transports.length > 0)
            void relay.sync().catch(() => undefined);
        };
        target.addEventListener("online", onActive);
        target.addEventListener("focus", onActive);
        target.addEventListener("visibilitychange", onActive);
      }
    } catch (caught) {
      state.setError({
        type: "InitError",
        message: caught instanceof Error ? caught.message : String(caught),
      });
      throw caught;
    }
  };

  const importLegacy = async (
    legacyDbName: string,
  ): Promise<{ imported: number; skipped: number }> => {
    // Versioned so a fixed importer re-runs for users imported by an older,
    // buggy version. v2: coerce NULL booleans (legacy schemas allowed NULL where
    // ours requires SqliteBoolean) so those rows aren't silently dropped — v1
    // lost e.g. accounts whose `excludeFromReports` was NULL. v3: also count +
    // LOG rows we can't import (required non-boolean column NULL/invalid in
    // legacy data) instead of dropping them silently.
    const IMPORT_VERSION = LEGACY_IMPORT_VERSION;
    const done = Number(store.getMeta("legacyImported") ?? "0") || 0;
    if (!state.driver || done >= IMPORT_VERSION)
      return { imported: 0, skipped: 0 };
    let imported = 0;
    let skipped = 0;
    const skipReasons: string[] = [];
    try {
      const legacy = await deps.createSqliteDriver(legacyDbName);
      for (const table of Object.keys(schema)) {
        const columns = schema[table];
        // SqliteBoolean columns accept 0 and 1 but reject 2 — used to spot
        // required booleans so a legacy NULL/missing becomes `false`, not a
        // drop. (PositiveInt/FiniteNumber/strings don't match, so e.g. `order`
        // stays untouched.)
        const boolColumns = Object.entries(columns)
          .filter(
            ([, type]) =>
              type.from(0).ok && type.from(1).ok && !type.from(2).ok,
          )
          .map(([name]) => name);
        let rows: Record<string, unknown>[] = [];
        try {
          rows = legacy.select<Record<string, unknown>>(
            `select * from "${table}"`,
          );
        } catch {
          continue; // table absent in legacy db
        }
        for (const row of rows) {
          if (typeof row.id !== "string") continue;
          // Re-run recovers only rows not already imported (no churn on the rows
          // a prior import got right).
          const exists =
            state.driver.select(
              `select 1 from "${table}" where id = ? limit 1`,
              [row.id],
            ).length > 0;
          if (exists) continue;
          const sanitized: Record<string, unknown> = { ...row };
          for (const name of boolColumns) {
            if (sanitized[name] === null || sanitized[name] === undefined) {
              sanitized[name] = sqliteFalse;
            }
          }
          const result = mutations.mutate(table, sanitized, "upsert");
          if (result.ok) {
            imported += 1;
          } else {
            skipped += 1;
            if (skipReasons.length < 20) {
              skipReasons.push(`${table}#${row.id}: ${result.error.message}`);
            }
          }
        }
      }
    } catch (caught) {
      // No legacy database, or incompatible — leave the new db untouched.
      console.warn("importLegacy: legacy db unreadable", caught);
    }
    store.setMeta("legacyImported", String(IMPORT_VERSION));
    if (imported > 0) queryCache.refreshQueries(Object.keys(schema));
    if (skipped > 0) {
      // Visible, not silent: a column was NULL/invalid for a required field we
      // can't safely default (e.g. a NULL amount/date/name). Surfaced so it can
      // be investigated rather than vanishing.
      console.warn(
        `importLegacy: skipped ${skipped} legacy row(s) that failed validation:`,
        skipReasons,
      );
    }
    return { imported, skipped };
  };

  const restoreAppOwner = async (
    mnemonic: string,
    options: { force?: boolean } | undefined,
    reloadApp: () => void,
  ): Promise<void> => {
    const normalized = normalizeMnemonic(mnemonic);
    if (!isRecoveryMnemonic(normalized))
      throw new Error("Invalid recovery phrase.");
    const restored = await deriveIdentity(normalized);
    // Safety: don't destroy local data unless the relay confirms this owner
    // actually has a backup. A valid-but-wrong phrase derives a different, empty
    // owner; without this check, restore would wipe everything and restore
    // nothing, with no way back. `force` overrides (intentional new owner). If
    // there are no relays configured we can't verify -> refuse unless forced.
    if (!options?.force) {
      const bases = relay.relayBaseUrls();
      let hasBackup = false;
      for (const base of bases) {
        try {
          const url = new URL(`${base}/v1/events`);
          url.searchParams.set("ownerId", restored.ownerId);
          url.searchParams.set("after", "");
          url.searchParams.set("limit", "1");
          const res = await fetchImpl(url.toString(), {
            headers: { Authorization: `Bearer ${restored.relayAuth}` },
          });
          if (res.ok) {
            const b = (await res.json()) as { events?: unknown[] };
            if (Array.isArray(b.events) && b.events.length > 0) {
              hasBackup = true;
              break;
            }
          }
        } catch {
          // network/relay error — treat as "unverified"
        }
      }
      if (!hasBackup) {
        throw new Error(
          "No backup found for this recovery phrase (the relay is empty or unreachable). Nothing was changed. Use force to switch to a new owner.",
        );
      }
    }
    // Verified (or forced): switch owners (reuse the identity already derived
    // above), then sync and reload so the engine reboots with the restored owner
    // and pulls fresh. The soft switch also covers platforms without a hard
    // reload (RN); on web the reload supersedes it.
    await switchOwner(normalized, restored);
    if (state.transports.length > 0) void relay.sync().catch(() => undefined);
    reloadApp();
  };

  const resetAppOwner = async (reloadApp: () => void): Promise<void> => {
    const mnemonic = createMnemonic();
    await switchOwner(mnemonic, await deriveIdentity(mnemonic));
    reloadApp();
  };

  const kdf = deps.deriveKeyFromPassphrase;

  // Build an encrypted, portable snapshot of the whole database (every table +
  // the recovery phrase + sync cursors). Returns the envelope; file I/O
  // (download / share sheet) stays with the caller. Default keying derives the
  // file key from the owner's recovery phrase; `passphrase` opts into the
  // separate-secret mode instead.
  const exportDatabase = async (options?: {
    passphrase?: string;
  }): Promise<EncryptedEnvelopeV1> => {
    const owner = state.appOwnerValue;
    if (!owner?.mnemonic) {
      throw new Error(
        "The recovery phrase isn't ready yet. Try again in a moment.",
      );
    }
    const json = JSON.stringify(store.exportSnapshot(owner.mnemonic));
    if (options?.passphrase) {
      return encryptStringWithPassphrase(options.passphrase, json, { kdf });
    }
    const keyBytes = await deriveBackupKeyBytes(owner.mnemonic);
    return encryptStringWithKey(keyBytes, json, { ownerId: owner.id });
  };

  const isDbSnapshot = (value: unknown): value is DbSnapshot => {
    if (!value || typeof value !== "object") return false;
    const s = value as Partial<DbSnapshot>;
    return (
      s.format === "simplysync-db-snapshot" &&
      s.version === 1 &&
      typeof s.mnemonic === "string" &&
      typeof s.tables === "object" &&
      s.tables !== null &&
      typeof s.meta === "object" &&
      s.meta !== null
    );
  };

  // Adopt the backup's identity and replace all local data with the snapshot,
  // then reload. The encrypted file proves ownership, so — unlike
  // restoreAppOwner — no relay is consulted. Ordering (persist phrase -> wipe +
  // write rows + restore meta -> swap identity -> reload) means there's no
  // post-reload re-import dance: the data is already in place.
  const restoreSnapshot = async (
    snapshot: DbSnapshot,
    reloadApp: () => void,
  ): Promise<void> => {
    const normalized = normalizeMnemonic(snapshot.mnemonic);
    if (!isRecoveryMnemonic(normalized)) {
      throw new Error("Backup contains an invalid recovery phrase.");
    }
    const derived = await deriveIdentity(normalized);
    await deps.secureStorage.setItem(mnemonicKey, normalized);
    store.importSnapshot({ ...snapshot, mnemonic: normalized });
    state.identity = derived;
    state.appOwnerValue = {
      id: derived.ownerId,
      mnemonic: normalized,
      writeKey: derived.relayAuth,
    };
    state.appOwnerPromise = Promise.resolve(state.appOwnerValue);
    // Re-seed the in-memory HLC high-water mark from the restored metadata so
    // the clock stays monotonic (see createClock).
    state.hlcTime = Number(store.getMeta("hlc:time") ?? "0") || 0;
    state.hlcCounter = Number(store.getMeta("hlc:counter") ?? "0") || 0;
    queryCache.refreshQueries(Object.keys(schema));
    if (state.transports.length > 0) void relay.sync().catch(() => undefined);
    reloadApp();
  };

  const importDatabase = async (
    envelope: EncryptedEnvelopeV1 | string,
    options: { passphrase?: string; recoveryPhrase?: string } | undefined,
    reloadApp: () => void,
  ): Promise<void> => {
    let parsed: unknown = envelope;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        throw new InvalidBackupEnvelopeError();
      }
    }
    if (!isEncryptedEnvelope(parsed)) {
      throw new InvalidBackupEnvelopeError();
    }

    let json: string;
    if (parsed.keying === "passphrase") {
      if (!options?.passphrase) {
        throw new Error("This backup is passphrase-protected.");
      }
      json = await decryptStringWithPassphrase(options.passphrase, parsed, {
        kdf,
      });
    } else {
      const phrase = options?.recoveryPhrase ?? state.appOwnerValue?.mnemonic;
      if (!phrase) {
        throw new Error("This backup needs its recovery phrase to restore.");
      }
      const normalized = normalizeMnemonic(phrase);
      if (!isRecoveryMnemonic(normalized)) {
        throw new Error("Invalid recovery phrase.");
      }
      // Reject a wrong phrase up front (clearer than a generic decrypt failure).
      const derived = await deriveIdentity(normalized);
      if (derived.ownerId !== parsed.ownerId) {
        throw new Error("This backup belongs to a different recovery phrase.");
      }
      const keyBytes = await deriveBackupKeyBytes(normalized);
      json = await decryptStringWithKey(keyBytes, parsed);
    }

    let body: unknown;
    try {
      body = JSON.parse(json);
    } catch {
      throw new InvalidBackupEnvelopeError("Backup contents are corrupted.");
    }
    if (!isDbSnapshot(body)) {
      throw new InvalidBackupEnvelopeError(
        "Backup contents are not recognized.",
      );
    }
    await restoreSnapshot(body, reloadApp);
  };

  return {
    init,
    importLegacy,
    restoreAppOwner,
    resetAppOwner,
    exportDatabase,
    importDatabase,
  };
}
