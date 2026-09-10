import {
  base64UrlEncode,
  compareHlc,
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
import { createId } from "./ids.js";
import type { QueryCache } from "./query-cache.js";
import type { RelaySync } from "./relay.js";
import type { EngineState } from "./state.js";
import type { Clock, Store } from "./store.js";

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
  schema: SchemaDefinition,
  schemaVersion: number = SYNC_SCHEMA_VERSION,
  maxEventBytes: number = 256 * 1024,
) {
  // Reject a write whose encrypted event would exceed the relay's per-event cap
  // AT WRITE TIME, so it never enters the outbox. Otherwise the relay 413s it on
  // every push and it head-of-line-blocks every later write behind it (a
  // permanent stall reported, misleadingly, as "quota exceeded"). Estimate the
  // envelope from the plaintext: AES-GCM ciphertext is plaintext + a 16-byte
  // tag, base64 inflates 4/3, plus a fixed allowance for the nonce + header.
  const eventTooLargeMessage = (payloadJson: string): string | null => {
    const payloadBytes = new TextEncoder().encode(payloadJson).length;
    const estimated = Math.ceil(((payloadBytes + 16) * 4) / 3) + 512;
    if (estimated <= maxEventBytes) return null;
    return (
      `Event is too large to sync (~${estimated} bytes, limit ${maxEventBytes}). ` +
      "A large JSON column is the usual cause — use the blob API for large values."
    );
  };
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
      // A caller-supplied stamp bypasses the clock, so it can sort at or below
      // the row's current version. Peers would keep their copy under
      // last-writer-wins while this device overwrote its own — and the next
      // ordinary edit here would re-stamp the regressed values and replicate
      // them. Equal is refused too: the outbox is keyed by HLC, so the event
      // would be dropped while its row committed. Read the version regardless
      // of mode — insert also overwrites an existing row.
      const current =
        driver.select<{ updatedAt: string | null }>(
          `select "updatedAt" from "${table}" where id = ?`,
          [id],
        )[0]?.updatedAt ?? null;
      if (current !== null && compareHlc(current, providedUpdatedAt) >= 0) {
        return {
          ok: false,
          message: `${table}.updatedAt: must be newer than the row's current version.`,
        };
      }
      if (store.hasQueuedEvent(providedUpdatedAt)) {
        return {
          ok: false,
          message: `${table}.updatedAt: collides with an event already queued for sync.`,
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
    // Only replicated (non-local) writes hit a relay's per-event cap.
    if (!local) {
      const tooLarge = eventTooLargeMessage(payloadJson);
      if (tooLarge) return { ok: false, error: { message: tooLarge } };
    }

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
    //
    // Otherwise kick a sync so the pending outbox row gets sealed (encrypted)
    // and pushed promptly. Attempted even with no relay configured yet, so the
    // row doesn't sit unencrypted at rest indefinitely; `relay.sync()` itself
    // no-ops the network push/pull when there's nothing to push to, but still
    // runs the seal step (see relay.ts `sealPendingOutbox`).
    if (!local) void relay.sync().catch(() => undefined);
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
    // Engine-minted HLCs are unique by construction; caller-supplied ones are
    // not, and two ops sharing one would leave a single outbox event for two
    // row writes. Refuse before anything is written, like every other batch
    // validation failure.
    if (new Set(prepared.map((r) => r.hlc)).size !== prepared.length) {
      return {
        ok: false,
        error: { message: "updatedAt: two ops in one batch share an HLC." },
      };
    }
    // Fail the whole batch before any write if any replicated event is too
    // large (matches batch's prepare-then-fail-atomically design).
    if (!local) {
      for (const payloadJson of payloads) {
        const tooLarge = eventTooLargeMessage(payloadJson);
        if (tooLarge) return { ok: false, error: { message: tooLarge } };
      }
    }

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

    // One sync for the whole batch, same fire-and-forget seal+push as `mutate`.
    if (!local && prepared.length > 0) void relay.sync().catch(() => undefined);
    queryCache.refreshQueries([...new Set(prepared.map((r) => r.table))]);
    options?.onComplete?.();
    return { ok: true, ids: prepared.map((r) => r.id) };
  };

  return { mutate, batch };
}

/**
 * Boot + owner management: derive/persist the identity and device id, open the
 * DB and create the schema (`init`), and the restore/reset owner flows (which
 * wipe local data and adopt a new identity).
 */
export function createLifecycle(
  state: EngineState,
  store: Store,
  queryCache: QueryCache,
  relay: RelaySync,
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
  const ensureIdentity = async (): Promise<LocalFirstIdentity> => {
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
  };

  // Switch to a different owner (restore an existing key/phrase, or reset to a
  // fresh one): persist the credential, wipe local data, adopt the new identity,
  // and re-point the cached appOwner promise. Callers handle reload (and any
  // post-switch sync) themselves.
  const switchOwner = async (derived: LocalFirstIdentity): Promise<void> => {
    await deps.secureStorage.setItem(mnemonicKey, derived.recoveryKey);
    store.wipeLocalData();
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
      // Seed the HLC clock from its persisted high-water mark BEFORE replaying
      // deferred events. Replay calls clock.observeHlc, which compares against
      // — and can persist — state.hlcTime; if that is still 0, a replayed
      // event's lower millis regresses the mark below its true value, and later
      // local writes then mint HLCs that sort below edits already applied (a
      // silent lost update under LWW). Seeding first keeps the mark monotonic.
      ({ time: state.hlcTime, counter: state.hlcCounter } =
        store.clockHighWaterMark());
      await relay.replayDeferredAtBoot();
      state.schemaReady = true;
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
    await switchOwner(restored);
    if (state.transports.length > 0) void relay.sync().catch(() => undefined);
    reloadApp();
  };

  const resetAppOwner = async (
    options: { force?: boolean } | undefined,
    reloadApp: () => void,
  ): Promise<void> => {
    // Reset is strictly more destructive than restore: it wipes local data AND
    // adopts an owner nothing has ever synced, so there is no relay to pull the
    // data back from. It gets at least restoreAppOwner's care. Each refusal
    // names its own condition so the app can offer the matching next step
    // (wait for sync vs. exportDatabase first) rather than one vague warning.
    if (!options?.force) {
      const pending = store.pendingOutboxCount();
      if (pending > 0) {
        throw new Error(
          `${pending} change(s) haven't reached a sync relay yet. ` +
            "Back up your data first, or wait for sync to finish. " +
            "Nothing was changed.",
        );
      }
      if (relay.relayBaseUrls().length === 0) {
        throw new Error(
          "No sync relay is configured, so this data exists only on this " +
            "device. Back up your data first. Nothing was changed.",
        );
      }
      // `events > 0` (not merely `reachable`) is the check that matters: a
      // relay that answers but holds nothing for this owner is no safer than an
      // unreachable one.
      const statuses = await relay.getRelayStatuses();
      if (!statuses.some((status) => status.reachable)) {
        throw new Error(
          "The sync service could not be reached, so this data can't be " +
            "confirmed as backed up. Back up your data first. " +
            "Nothing was changed.",
        );
      }
      if (!statuses.some((status) => (status.events ?? 0) > 0)) {
        throw new Error(
          "No sync relay holds a copy of this data yet. Back up your data " +
            "first. Nothing was changed.",
        );
      }
    }
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
    ({ time: state.hlcTime, counter: state.hlcCounter } =
      store.clockHighWaterMark());
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
    restoreAppOwner,
    resetAppOwner,
    exportDatabase,
    importDatabase,
  };
}
