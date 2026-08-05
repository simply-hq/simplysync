import {
  base64UrlEncode,
  createMnemonic,
  decryptStringWithKey,
  decryptStringWithPassphrase,
  deriveBackupKeyBytes,
  deriveIdentity,
  encryptStringWithKey,
  encryptStringWithPassphrase,
  InvalidBackupEnvelopeError,
  isEncryptedEnvelope,
  SYNC_SCHEMA_VERSION,
  type EncryptedEnvelopeV1,
  type LocalFirstIdentity,
} from "@simplysync/protocol";
import {
  sqliteFalse,
  sqliteTrue,
  type Id,
  type SqliteBoolean,
} from "../type.js";
import type {
  AppOwner,
  BatchResult,
  DbSnapshot,
  MutationOptions,
  MutationResult,
  SchemaDefinition,
  SyncEngineConfig,
  SyncEngineDeps,
} from "../engine-types.js";
import { LEGACY_IMPORT_VERSION } from "./constants.js";
import { createId } from "./ids.js";
import type { QueryCache } from "./query-cache.js";
import type { RelaySync } from "./relay.js";
import type { EngineState } from "./state.js";
import type { Clock, Store } from "./store.js";
import type { TabBridge } from "./tab-sync.js";

export type Mutations = ReturnType<typeof createMutations>;

/**
 * The local write path. `mutate` validates + merges a row, then — in the SAME
 * transaction — writes the row and inserts its durable, plaintext-pending
 * outbox marker (see store.ts `insertPendingOutboxEvent`), so a row is never
 * committed without a way to eventually replicate it, even if the process
 * dies immediately after. Encryption is deferred to the async seal step
 * (relay.ts `sealPendingOutbox`, run before every push) since it can't happen
 * inside a synchronous transaction. `insert`/`update`/`upsert` are the three
 * modes.
 */
export function createMutations(
  state: EngineState,
  store: Store,
  clock: Clock,
  queryCache: QueryCache,
  relay: RelaySync,
  bridge: TabBridge,
  schema: SchemaDefinition,
  schemaVersion: number = SYNC_SCHEMA_VERSION,
) {
  // A validated, merged row ready to write. Splitting "prepare" (pure-ish:
  // validate + merge + stamp the HLC) from "write" lets `batch` prepare every
  // op up front and fail atomically before touching the database.
  interface PreparedRow {
    readonly table: string;
    readonly id: string;
    readonly hlc: string;
    readonly merged: Record<string, unknown>;
    readonly expectedUpdatedAt?: string;
    readonly expectedDeleted: boolean;
  }

  const prepareRow = (
    table: string,
    values: Record<string, unknown>,
    mode: "insert" | "update" | "upsert" | "delete" | "restore",
    expectedUpdatedAt?: string,
    expectedDeleted: boolean = false,
  ): { ok: true; prepared: PreparedRow } | { ok: false; message: string } => {
    const { driver } = state;
    if (!driver) return { ok: false, message: "Database not ready." };
    if (!(table in schema))
      return { ok: false, message: `Unknown table: ${table}` };

    let id: Id;
    if ("id" in values) {
      if (typeof values.id !== "string" || values.id.length === 0) {
        return { ok: false, message: `${table}.id: Expected a non-empty id string.` };
      }
      id = values.id;
    } else {
      id = createId();
    }
    const existing =
      mode === "insert"
        ? null
        : driver.select<Record<string, unknown>>(
            `select * from "${table}" where id = ?`,
            [id],
          )[0] ?? null;

    if (mode === "update" && !existing)
      return { ok: false, message: `Row not found: ${id}` };

    const { row, error: coerceError } = store.coerceValues(table, {
      ...values,
      id,
    });
    if (coerceError) return { ok: false, message: coerceError };

    // `delete` is a soft delete: force the tombstone flag so the deletion
    // replicates and wins LWW (a hard local delete would resurrect from a peer
    // on the next pull). Idempotent — deleting a row that isn't local yet still
    // writes a tombstone that supersedes the row when it arrives.
    if (mode === "delete") row.isDeleted = sqliteTrue;
    else if (mode === "restore") row.isDeleted = sqliteFalse;
    else if ("isDeleted" in values) {
      if (values.isDeleted !== 0 && values.isDeleted !== 1) {
        return {
          ok: false,
          message: `${table}.isDeleted: Expected a SQLite boolean (0 or 1).`,
        };
      }
      row.isDeleted = values.isDeleted;
    }

    if ("updatedAt" in values && typeof values.updatedAt !== "string") {
      return {
        ok: false,
        message: `${table}.updatedAt: Expected a valid SimplySync HLC.`,
      };
    }
    const providedUpdatedAt = values.updatedAt as string | undefined;
    let hlc: string;
    if (providedUpdatedAt !== undefined) {
      if (!clock.observeHlc(providedUpdatedAt)) {
        return {
          ok: false,
          message: "updatedAt must be a valid, non-future SimplySync HLC.",
        };
      }
      hlc = providedUpdatedAt;
    } else {
      hlc = clock.nextHlc();
    }
    if ("createdAt" in values && typeof values.createdAt !== "string") {
      return {
        ok: false,
        message: `${table}.createdAt: Expected a string.`,
      };
    }
    const providedCreatedAt = values.createdAt as string | undefined;
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

    return {
      ok: true,
      prepared: { table, id, hlc, merged, expectedUpdatedAt, expectedDeleted },
    };
  };

  const assertExpectedVersion = (row: PreparedRow): void => {
    if (row.expectedUpdatedAt === undefined) return;
    const { driver } = state;
    if (!driver) throw new Error("Database not ready.");
    const current =
      driver.select<Record<string, unknown>>(
        `select "updatedAt", "isDeleted" from "${row.table}" where "id" = ?`,
        [row.id],
      )[0] ?? null;
    if (
      current?.updatedAt !== row.expectedUpdatedAt ||
      current.isDeleted !==
        (row.expectedDeleted ? sqliteTrue : sqliteFalse)
    ) {
      throw new Error(
        `Write conflict: ${row.table}/${row.id} changed or was deleted.`,
      );
    }
  };

  // The plaintext event a PreparedRow replicates — same shape the old async
  // `enqueue` encrypted, minus the encryption. `op` is always "upsert": a soft
  // delete is represented by `isDeleted` inside `value`, not a distinct sync
  // op (mirrors the apply side, which never reads `payload.op`).
  const buildOutboxPayload = (row: PreparedRow): string =>
    JSON.stringify({
      schemaVersion,
      table: row.table,
      op: "upsert" as const,
      rowId: row.id,
      hlc: row.hlc,
      value: row.merged,
    });

  // Kick a sync so any pending outbox rows get sealed (encrypted) and pushed
  // promptly. Skipped entirely for local-only writes (see
  // MutationOptions.local). Always attempted — even with no relay configured
  // yet — so a pending row doesn't sit unencrypted at rest indefinitely;
  // `relay.sync()` itself no-ops the network push/pull when there's nothing to
  // push to, but still runs the seal step (see relay.ts `sealPendingOutbox`).
  const replicate = (rows: readonly PreparedRow[], local?: boolean): void => {
    if (local || rows.length === 0) return;
    void relay.sync().catch(() => undefined);
  };

  const mutate = (
    table: string,
    values: Record<string, unknown>,
    mode: "insert" | "update" | "upsert" | "delete" | "restore",
    options?: MutationOptions,
  ): MutationResult => {
    const { driver } = state;
    if (!driver)
      return { ok: false, error: { message: "Database not ready." } };

    const prep = prepareRow(
      table,
      values,
      mode,
      options?.expectedUpdatedAt,
      options?.expectedDeleted === true,
    );
    if (!prep.ok) return { ok: false, error: { message: prep.message } };
    const { id, merged } = prep.prepared;
    const local = options?.local === true;
    const payloadJson = buildOutboxPayload(prep.prepared);

    try {
      driver.transaction(() => {
        assertExpectedVersion(prep.prepared);
        store.writeRow(table, merged);
        // Atomic with the row write: if this insert throws, the whole
        // transaction (including the row write above) rolls back, so a
        // committed non-local row always has a pending-or-sealed outbox row.
        if (!local) {
          store.insertPendingOutboxEvent(prep.prepared.hlc, payloadJson);
        }
      });
    } catch (caught) {
      return {
        ok: false,
        error: {
          message: caught instanceof Error ? caught.message : String(caught),
        },
      };
    }

    // Local-only writes (e.g. a streaming AI reply, see MutationOptions.local)
    // skip the outbox + push so peers aren't flooded with soon-superseded
    // events. The row is already persisted above and queries refresh below, so
    // the local UI is fully up to date — only replication waits for a normal
    // (committing) write to the same row.
    replicate([prep.prepared], options?.local);
    // Other tabs see even `local` writes live; they just don't stage them.
    bridge.publish([
      { eventId: prep.prepared.hlc, payloadJson, outbox: !local },
    ]);
    queryCache.refreshQueries([table]);
    options?.onComplete?.();
    return { ok: true, value: { id } };
  };

  // Write many rows at once. Atomic: every op is validated + merged first, so a
  // single invalid op aborts the whole batch before anything is written. On
  // success all rows are written in ONE SQLite transaction, each affected table
  // is refreshed ONCE (not once per row — reactive queries re-run a single
  // time), and replication fires a single sync. Bulk-seed a todo list, import a
  // chat history, or persist several AI-generated items in one shot.
  //
  // Each op is prepared against the pre-batch database state (no intra-batch
  // read-your-writes); for writes that depend on an earlier op in the same
  // batch, use separate calls. `mode` defaults to "upsert".
  const batch = (
    ops: ReadonlyArray<{
      table: string;
      values: Record<string, unknown>;
      mode?: "insert" | "update" | "upsert" | "delete";
      expectedUpdatedAt?: string;
    }>,
    options?: MutationOptions,
  ): BatchResult => {
    const { driver } = state;
    if (!driver)
      return { ok: false, error: { message: "Database not ready." } };

    const prepared: PreparedRow[] = [];
    for (const op of ops) {
      const prep = prepareRow(
        op.table,
        op.values,
        op.mode ?? "upsert",
        op.expectedUpdatedAt,
      );
      if (!prep.ok)
        return { ok: false, error: { message: prep.message } };
      prepared.push(prep.prepared);
    }
    const local = options?.local === true;
    const payloads = prepared.map(buildOutboxPayload);

    try {
      driver.transaction(() => {
        for (const [i, row] of prepared.entries()) {
          assertExpectedVersion(row);
          store.writeRow(row.table, row.merged);
          if (!local) {
            store.insertPendingOutboxEvent(row.hlc, payloads[i]!);
          }
        }
      });
    } catch (caught) {
      return {
        ok: false,
        error: {
          message: caught instanceof Error ? caught.message : String(caught),
        },
      };
    }

    replicate(prepared, options?.local);
    bridge.publish(
      prepared.map((row, i) => ({
        eventId: row.hlc,
        payloadJson: payloads[i]!,
        outbox: !local,
      })),
    );
    queryCache.refreshQueries([...new Set(prepared.map((r) => r.table))]);
    options?.onComplete?.();
    return { ok: true, ids: prepared.map((r) => r.id) };
  };

  return { mutate, batch };
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
  bridge: TabBridge,
  schema: SchemaDefinition,
  deps: SyncEngineDeps,
  config: SyncEngineConfig,
  fetchImpl: typeof fetch,
) {
  // Keep the historical key name so existing installs retain their identity.
  // Its value is now a generic recovery credential: either an `sf1_` key or a
  // BIP39 phrase.
  const mnemonicKey = `${config.name}:mnemonic`;
  const deviceKey = `${config.name}:deviceId`;

  const appOwnerFromIdentity = (identity: LocalFirstIdentity): AppOwner => ({
    id: identity.ownerId,
    recoveryKey: identity.recoveryKey,
    ...(identity.mnemonic ? { mnemonic: identity.mnemonic } : {}),
    writeKey: identity.relayAuth,
  });

  // `deriveIdentity` is the single validator and normalizer for both supported
  // credential forms. Keeping that decision in the protocol prevents lifecycle
  // paths from drifting back to mnemonic-only validation.
  const tryDeriveIdentity = async (
    value: string | null | undefined,
  ): Promise<LocalFirstIdentity | null> => {
    if (!value) return null;
    try {
      return await deriveIdentity(value);
    } catch {
      return null;
    }
  };

  const requireIdentity = async (
    value: string,
    message: string,
  ): Promise<LocalFirstIdentity> => {
    const identity = await tryDeriveIdentity(value);
    if (!identity) throw new Error(message);
    return identity;
  };

  // Load a valid persisted credential or create-and-persist a fresh mnemonic.
  // With tab coordination this must run
  // inside a cross-tab lock: two tabs cold-booting the same fresh profile
  // would otherwise each mint a DIFFERENT mnemonic and race the write — two
  // identities in one session, events sealed under two owners.
  const ensureIdentity = async (): Promise<LocalFirstIdentity> => {
    const create = async (): Promise<LocalFirstIdentity> => {
      const existing = await deps.secureStorage.getItem(mnemonicKey);
      const existingIdentity = await tryDeriveIdentity(existing);
      if (existingIdentity) {
        // Persist the protocol-normalized spelling (trimmed native key or
        // normalized mnemonic) so every later boot sees one canonical value.
        if (existing !== existingIdentity.recoveryKey) {
          await deps.secureStorage.setItem(
            mnemonicKey,
            existingIdentity.recoveryKey,
          );
        }
        return existingIdentity;
      }
      const fresh = createMnemonic();
      const freshIdentity = await deriveIdentity(fresh);
      await deps.secureStorage.setItem(mnemonicKey, freshIdentity.recoveryKey);
      return freshIdentity;
    };
    return deps.tabSync ? deps.tabSync.withLock("identity", create) : create();
  };

  const loadIdentity = async (): Promise<void> => {
    const externalRecoveryKey =
      config.externalAppOwner?.recoveryKey ??
      config.externalAppOwner?.mnemonic;
    state.identity =
      (await tryDeriveIdentity(externalRecoveryKey)) ??
      (await ensureIdentity());
    state.appOwnerValue = appOwnerFromIdentity(state.identity);
    let storedDevice = await deps.secureStorage.getItem(deviceKey);
    if (!storedDevice) {
      const bytes = new Uint8Array(8);
      globalThis.crypto.getRandomValues(bytes);
      storedDevice = base64UrlEncode(bytes);
      await deps.secureStorage.setItem(deviceKey, storedDevice);
    }
    state.deviceId = storedDevice;
    if (deps.tabSync) {
      // Each tab is an independent HLC writer. A shared device id would let
      // two tabs mint the SAME event id in the same millisecond — colliding
      // outbox rows (one event silently dropped) and unresolvable LWW ties.
      const tag = new Uint8Array(3);
      globalThis.crypto.getRandomValues(tag);
      state.deviceId = `${storedDevice}.${base64UrlEncode(tag)}`;
    }
  };

  // Switch to a different owner (restore an existing key/phrase, or reset to a
  // fresh one): persist the credential, wipe local data, adopt the new identity,
  // and re-point the cached appOwner promise. Marks the one-time legacy import
  // as done so the post-reload boot doesn't resurrect the wiped legacy db.
  // Callers handle reload (and any post-switch sync) themselves.
  const switchOwner = async (derived: LocalFirstIdentity): Promise<void> => {
    await deps.secureStorage.setItem(mnemonicKey, derived.recoveryKey);
    store.wipeLocalData();
    store.setMeta("legacyImported", String(LEGACY_IMPORT_VERSION));
    state.identity = derived;
    state.appOwnerValue = appOwnerFromIdentity(derived);
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
      await relay.replayDeferredAtBoot();
      state.schemaReady = true;
      // Seed the HLC clock from its persisted high-water mark so it stays
      // monotonic across restarts (see createClock).
      state.hlcTime = Number(store.getMeta("hlc:time") ?? "0") || 0;
      state.hlcCounter = Number(store.getMeta("hlc:counter") ?? "0") || 0;
      // hydrate any active queries created before init finished
      queryCache.refreshQueries(Object.keys(schema));
      // Cross-tab events buffered while the snapshot was loading apply now;
      // from here on they apply live.
      bridge.start();
      // A promoted follower takes over the dead leader's relay duties. (The
      // snapshot persist that heals an unpersisted tail is the platform
      // coordinator's job — the engine doesn't own persistence.)
      deps.tabSync?.onPromoted(() => {
        if (state.transports.length > 0) {
          void relay.sync().catch(() => undefined);
          relay.startPolling();
        }
      });
      // A follower's staged foreign events should push promptly, not on the
      // next poll tick: when the leader applies a broadcast batch that staged
      // outbox rows, kick a sync.
      bridge.onApplied = () => {
        if (!deps.tabSync?.isLeader()) return;
        void relay.sync().catch(() => undefined);
      };
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
    recoveryKey: string,
    options: { force?: boolean } | undefined,
    reloadApp: () => void,
  ): Promise<void> => {
    const restored = await requireIdentity(
      recoveryKey,
      "Invalid recovery key or phrase.",
    );
    // Safety: don't destroy local data unless the relay confirms this owner
    // actually has a backup. A valid-but-wrong credential derives a different,
    // empty owner; without this check, restore would wipe everything and
    // restore nothing, with no way back. `force` overrides (intentional new
    // owner). If there are no relays configured we can't verify -> refuse unless
    // forced.
    if (!options?.force) {
      const bases = relay.relayBaseUrls();
      if (bases.length === 0) {
        throw new Error(
          "No sync relay is configured. Nothing was changed.",
        );
      }

      let hasBackup = false;
      let verifiedRelayCount = 0;
      for (const base of bases) {
        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const url = new URL(`${base}/v1/events`);
          url.searchParams.set("ownerId", restored.ownerId);
          url.searchParams.set("after", "");
          url.searchParams.set("limit", "1");
          const timeout = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              controller.abort();
              reject(new Error("Relay verification timed out."));
            }, 10_000);
          });
          const res = await Promise.race([
            fetchImpl(url.toString(), {
              headers: { Authorization: `Bearer ${restored.relayAuth}` },
              signal: controller.signal,
            }),
            timeout,
          ]);
          if (res.ok) {
            const b = (await res.json()) as { events?: unknown[] };
            if (Array.isArray(b.events)) {
              verifiedRelayCount += 1;
            }
            if (Array.isArray(b.events) && b.events.length > 0) {
              hasBackup = true;
              break;
            }
          }
        } catch {
          // Try the next configured relay. We distinguish a verified empty
          // owner from an unavailable service below.
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
      }
      if (!hasBackup) {
        if (verifiedRelayCount === 0) {
          throw new Error(
            "The sync service could not be reached to verify this recovery key or phrase. Nothing was changed.",
          );
        }
        throw new Error(
          "No backup found for this recovery key or phrase. Nothing was changed.",
        );
      }
    }
    // Verified (or forced): switch owners (reuse the identity already derived
    // above), then sync and reload so the engine reboots with the restored owner
    // and pulls fresh. The soft switch also covers platforms without a hard
    // reload (RN); on web the reload supersedes it.
    // Whole-database replacement: every other tab must stop writing/persisting
    // and reboot from the post-op snapshot (barrier placed AFTER verification,
    // so a wrong phrase doesn't reboot the other tabs for nothing).
    await deps.tabSync?.acquireExclusive();
    await switchOwner(restored);
    if (state.transports.length > 0) void relay.sync().catch(() => undefined);
    reloadApp();
  };

  const resetAppOwner = async (reloadApp: () => void): Promise<void> => {
    await deps.tabSync?.acquireExclusive();
    const mnemonic = createMnemonic();
    await switchOwner(await deriveIdentity(mnemonic));
    reloadApp();
  };

  const kdf = deps.deriveKeyFromPassphrase;

  // Build an encrypted, portable snapshot of the whole database (every table +
  // the recovery key/phrase + sync cursors). Returns the envelope; file I/O
  // (download / share sheet) stays with the caller. Default keying derives the
  // file key from the owner's recovery credential; `passphrase` opts into the
  // separate-secret mode instead.
  const exportDatabase = async (options?: {
    passphrase?: string;
  }): Promise<EncryptedEnvelopeV1> => {
    const owner = state.appOwnerValue;
    if (!owner?.recoveryKey) {
      throw new Error(
        "The recovery key isn't ready yet. Try again in a moment.",
      );
    }
    const json = JSON.stringify(
      store.exportSnapshot(owner.recoveryKey, owner.mnemonic),
    );
    if (options?.passphrase) {
      return encryptStringWithPassphrase(options.passphrase, json, { kdf });
    }
    const keyBytes = await deriveBackupKeyBytes(owner.recoveryKey);
    return encryptStringWithKey(keyBytes, json, { ownerId: owner.id });
  };

  const isDbSnapshot = (value: unknown): value is DbSnapshot => {
    if (!value || typeof value !== "object") return false;
    const s = value as Partial<DbSnapshot>;
    const recoveryKeyIsValid =
      s.recoveryKey === undefined || typeof s.recoveryKey === "string";
    const mnemonicIsValid =
      s.mnemonic === undefined || typeof s.mnemonic === "string";
    return (
      s.format === "simplysync-db-snapshot" &&
      s.version === 1 &&
      typeof s.exportedAt === "string" &&
      recoveryKeyIsValid &&
      mnemonicIsValid &&
      (typeof s.recoveryKey === "string" || typeof s.mnemonic === "string") &&
      typeof s.tables === "object" &&
      s.tables !== null &&
      !Array.isArray(s.tables) &&
      typeof s.meta === "object" &&
      s.meta !== null &&
      !Array.isArray(s.meta)
    );
  };

  // Adopt the backup's identity and replace all local data with the snapshot,
  // then reload. The encrypted file proves ownership, so — unlike
  // restoreAppOwner — no relay is consulted. Ordering (persist credential ->
  // wipe + write rows + restore meta -> swap identity -> reload) means there's
  // no post-reload re-import dance: the data is already in place.
  const restoreSnapshot = async (
    snapshot: DbSnapshot,
    reloadApp: () => void,
  ): Promise<void> => {
    const recoveryKey = snapshot.recoveryKey ?? snapshot.mnemonic;
    if (!recoveryKey) {
      throw new Error("Backup contains no recovery key or phrase.");
    }
    const derived = await requireIdentity(
      recoveryKey,
      "Backup contains an invalid recovery key or phrase.",
    );
    // New phrase-backed snapshots carry both fields so older engines can still
    // read them. Reject a malformed snapshot that makes the two disagree.
    if (snapshot.recoveryKey && snapshot.mnemonic) {
      const legacyIdentity = await requireIdentity(
        snapshot.mnemonic,
        "Backup contains an invalid recovery key or phrase.",
      );
      if (legacyIdentity.ownerId !== derived.ownerId) {
        throw new Error("Backup contains conflicting recovery credentials.");
      }
    }
    // Preflight every known row before changing the secure owner credential.
    // The subsequent SQLite replacement is transactional, but secure storage
    // is not part of that transaction.
    store.validateSnapshot(snapshot);
    // Whole-database replacement — same barrier rationale as restoreAppOwner.
    await deps.tabSync?.acquireExclusive();
    const previousRecoveryKey = await deps.secureStorage.getItem(mnemonicKey);
    try {
      await deps.secureStorage.setItem(mnemonicKey, derived.recoveryKey);
      store.importSnapshot(snapshot);
    } catch (restoreError) {
      // SQLite rolls a failed import back, but secure storage is outside that
      // transaction. Compensate it so a late constraint/I/O failure cannot
      // leave the next launch pointing at a different owner than this database.
      try {
        if (previousRecoveryKey === null) {
          await deps.secureStorage.removeItem(mnemonicKey);
        } else {
          await deps.secureStorage.setItem(mnemonicKey, previousRecoveryKey);
        }
      } catch (credentialError) {
        throw new Error(
          `Snapshot restore failed and the previous recovery credential could not be restored: ${String(credentialError)} (restore error: ${String(restoreError)})`,
        );
      }
      throw restoreError;
    }
    state.identity = derived;
    state.appOwnerValue = appOwnerFromIdentity(derived);
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
    options:
      | {
          passphrase?: string;
          recoveryKey?: string;
          recoveryPhrase?: string;
        }
      | undefined,
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
      const recoveryKey =
        options?.recoveryKey ??
        options?.recoveryPhrase ??
        state.appOwnerValue?.recoveryKey;
      if (!recoveryKey) {
        throw new Error("This backup needs its recovery key or phrase to restore.");
      }
      // Reject a wrong credential up front (clearer than a generic decrypt failure).
      const derived = await requireIdentity(
        recoveryKey,
        "Invalid recovery key or phrase.",
      );
      if (derived.ownerId !== parsed.ownerId) {
        throw new Error("This backup belongs to a different recovery key or phrase.");
      }
      const keyBytes = await deriveBackupKeyBytes(derived.recoveryKey);
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
