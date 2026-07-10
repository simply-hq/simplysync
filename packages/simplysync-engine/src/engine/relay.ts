import {
  compareHlc,
  decryptEnvelope,
  deriveStreamId,
  encryptPayload,
  type SyncEnvelope,
  type SyncPayload,
} from "@simplysync/protocol";
import type {
  RelayStatus,
  SchemaDefinition,
  SyncEngineConfig,
  SyncEngineDeps,
  SyncFailureKind,
  Transport,
} from "../engine-types";
import {
  PURGE_SWEEP_INTERVAL_MS,
  SYNC_OUTBOX_TABLE,
  SYNC_SEEN_TABLE,
  TOMBSTONE_RETENTION_MS,
} from "./constants";
import type { QueryCache } from "./query-cache";
import type { EngineState } from "./state";
import type { Clock, Store } from "./store";

export type RelaySync = ReturnType<typeof createRelaySync>;

/**
 * Relay synchronization over HTTP: push the encrypted outbox, pull + decrypt +
 * apply remote events (last-writer-wins by HLC), and poll periodically. The
 * relay only ever sees opaque envelopes — all crypto happens here on the client.
 */
export function createRelaySync(
  state: EngineState,
  store: Store,
  clock: Clock,
  queryCache: QueryCache,
  schema: SchemaDefinition,
  deps: SyncEngineDeps,
  config: SyncEngineConfig,
  fetchImpl: typeof fetch,
) {
  const DEFAULT_POLL_MS =
    typeof config.syncIntervalMs === "number" && config.syncIntervalMs > 0
      ? config.syncIntervalMs
      : 5000;
  // Backoff poll interval after a terminal failure so we don't re-push a
  // rejected batch every 5s forever (battery/network drain). focus/online and
  // local writes still trigger an immediate retry.
  const BACKOFF_POLL_MS = 5 * 60_000;
  // Cap the dedup set so it can't grow without bound. Safe to prune: the relay
  // cursor only advances, so pruned (oldest) eventIds won't be re-pulled, and
  // applyRemoteRow is idempotent (LWW) even if one were.
  const SEEN_CAP = 50_000;

  // Single-owner mutable state (never touched outside this module).
  let syncTimer: number | null = null;
  let pollIntervalMs = DEFAULT_POLL_MS;
  // Per-relay outcome of the last contact, keyed by base URL. SyncState
  // collapses multi-relay results ("synced" as long as ANY relay works — the
  // data is safe somewhere); this map keeps the per-relay truth so
  // getRelayStatuses can show which relay is failing behind a green state.
  const relayHealth = new Map<
    string,
    { lastSyncedAt?: string; lastFailure?: RelayStatus["lastFailure"] }
  >();

  const httpError = (op: string, status: number): Error => {
    const err = new Error(`${op} failed: ${status}`) as Error & {
      status?: number;
    };
    err.status = status;
    return err;
  };

  // Terminal kinds need user/operator action (re-auth, free quota, fix request),
  // so the poller backs off rather than hammering. rateLimited also backs off
  // but is not "terminal" (it self-heals).
  const TERMINAL_KINDS = new Set<SyncFailureKind>([
    "authRejected",
    "quotaExceeded",
    "badRequest",
  ]);

  // Map a thrown sync error to the structured taxonomy. HTTP errors carry a
  // status; a fetch that rejects has none (network-level), which we read as
  // offline (when the platform tells us) or otherwise unreachable.
  const classifyError = (
    caught: unknown,
  ): { kind: SyncFailureKind; status?: number; message: string } => {
    const status = (caught as { status?: number } | undefined)?.status;
    const message = caught instanceof Error ? caught.message : String(caught);
    if (typeof status === "number") {
      let kind: SyncFailureKind = "unknown";
      if (status === 401 || status === 403) kind = "authRejected";
      else if (status === 413) kind = "quotaExceeded";
      else if (status === 429) kind = "rateLimited";
      else if (status >= 500) kind = "serverError";
      else if (status >= 400) kind = "badRequest";
      return { kind, status, message };
    }
    const offline =
      typeof navigator !== "undefined" &&
      (navigator as { onLine?: boolean }).onLine === false;
    return { kind: offline ? "offline" : "unreachable", message };
  };

  const relayBaseUrls = (): string[] =>
    state.transports.map((t) =>
      t.url.replace(/^wss:\/\//u, "https://").replace(/^ws:\/\//u, "http://"),
    );

  // Encrypt every outbox row still holding the durable, plaintext-pending
  // marker written atomically by the write path (see store.ts
  // `insertPendingOutboxEvent`) — identified by `envelope_json = ''` — and
  // fill in its real envelope. Run at the start of every `sync()` (so it also
  // covers boot: a crash between a write and its seal is repaired by the very
  // first sync call) and BEFORE any push, so a relay only ever sees sealed
  // envelopes. Idempotent: the `and envelope_json = ''` in the update means a
  // row already sealed by a previous call (or a concurrent one) is simply
  // skipped, never re-encrypted. One bad row (e.g. a corrupt payload_json)
  // surfaces via state.setError and is skipped rather than blocking the rest.
  const sealPendingOutbox = async (): Promise<void> => {
    const { identity, driver } = state;
    if (!identity || !driver) return;
    const pending = driver.select<{ event_id: string; payload_json: string }>(
      `select event_id, payload_json from "${SYNC_OUTBOX_TABLE}" where envelope_json = '' and payload_json is not null order by event_id asc`,
    );
    for (const row of pending) {
      try {
        const payload = JSON.parse(row.payload_json) as SyncPayload<
          Record<string, unknown>
        >;
        const envelope = await encryptPayload(
          identity,
          { eventId: row.event_id, deviceId: state.deviceId },
          payload,
        );
        driver.exec(
          `update "${SYNC_OUTBOX_TABLE}" set envelope_json = ? where event_id = ? and envelope_json = ''`,
          [JSON.stringify(envelope), row.event_id],
        );
      } catch (caught) {
        state.setError({
          type: "SealError",
          message: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }
  };

  const pushOutbox = async (baseUrl: string): Promise<number> => {
    const { identity, driver } = state;
    if (!identity || !driver) return 0;
    // Per-relay push cursor so EVERY configured relay receives a full copy of
    // this device's events (write redundancy), not just whichever relay is
    // contacted first. A single global "pushed_at is null" filter would let the
    // first relay drain the outbox and starve the rest. Outbox event_ids are
    // this device's own HLCs — monotonically increasing — so a string
    // high-water mark paginates correctly. On upgrade the cursor is unset and
    // starts at "" (re-push everything once; the relay dedupes by event id).
    // `envelope_json != ''` is a safety net: sealPendingOutbox runs before
    // this at the start of every sync(), so by the time we get here nearly
    // everything is already sealed — this just guarantees a relay never
    // receives an unsealed (plaintext-pending) marker.
    const cursorKey = `push:${baseUrl}`;
    const after = store.getMeta(cursorKey) ?? "";
    const events = driver.select<{ event_id: string; envelope_json: string }>(
      `select event_id, envelope_json from "${SYNC_OUTBOX_TABLE}" where event_id > ? and envelope_json != '' order by event_id asc limit 1000`,
      [after],
    );
    if (events.length === 0) return 0;
    const response = await fetchImpl(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${identity.relayAuth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ownerId: identity.ownerId,
        events: events.map((e) => JSON.parse(e.envelope_json)),
      }),
    });
    if (!response.ok) throw httpError("push", response.status);
    const pushedAt = new Date().toISOString();
    // One transaction for the whole batch's pushed_at updates instead of one
    // auto-commit per event — same effect, far fewer commits for a big batch.
    driver.transaction(() => {
      for (const event of events) {
        // `pushed_at` means "reached at least one relay" — it drives the
        // pending-outbox count and the purge guard. Keep the earliest via
        // coalesce so re-pushes to other relays don't reset it.
        driver.exec(
          `update "${SYNC_OUTBOX_TABLE}" set pushed_at = coalesce(pushed_at, ?) where event_id = ?`,
          [pushedAt, event.event_id],
        );
      }
    });
    store.setMeta(cursorKey, events[events.length - 1]!.event_id);
    return events.length;
  };

  // Matches the relays' MAX_STREAMS_PER_COMPACT bound (wire limit, like
  // MAX_EVENTS_PER_PUSH for push).
  const COMPACT_STREAMS_BATCH = 1000;

  // Ask one relay to drop every event of the given (already locally-purged)
  // streams. Idempotent on the relay; ok=false means "retry next sync".
  const postCompactStreams = async (
    base: string,
    streamIds: readonly string[],
  ): Promise<boolean> => {
    const { identity } = state;
    if (!identity) return false;
    const response = await fetchImpl(`${base}/v1/streams/compact`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${identity.relayAuth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ownerId: identity.ownerId, streamIds }),
    });
    return response.ok;
  };

  // Drain the durable stream-purge queue (_sync_purge, written atomically by
  // the store's hard deletes): derive each purged row's streamId — possible
  // only because the queue kept the (table, rowId) plaintext; the row itself
  // is gone — and tell every configured relay to drop that stream. A relay
  // base is recorded per-row as it acks; the row leaves the queue once every
  // currently-configured relay has acked, so relays added mid-drain (or a
  // relay that was down) are retried on later syncs. Failures never throw:
  // purging is space reclamation, not sync correctness.
  const drainPurgeQueue = async (bases: string[]): Promise<void> => {
    const { identity, driver } = state;
    if (!identity || !driver) return;
    const entries = store.listPurgeQueue();
    if (entries.length === 0) return;
    // No relay to notify, or an identity without a streamKey can't name
    // streams (its events were pushed untagged and are unreachable by
    // stream-compaction anyway) — the queue has nothing actionable.
    if (bases.length === 0 || !identity.streamKey) {
      for (const e of entries) store.dropPurgeEntry(e.table, e.rowId);
      return;
    }
    const streamKey = identity.streamKey;
    const withIds = await Promise.all(
      entries.map(async (e) => ({
        ...e,
        streamId: await deriveStreamId(streamKey, e.table, e.rowId),
      })),
    );
    for (const base of bases) {
      const pending = withIds.filter((e) => !e.ackedBases.includes(base));
      for (let i = 0; i < pending.length; i += COMPACT_STREAMS_BATCH) {
        const batch = pending.slice(i, i + COMPACT_STREAMS_BATCH);
        let ok = false;
        try {
          ok = await postCompactStreams(
            base,
            batch.map((e) => e.streamId),
          );
        } catch {
          ok = false; // network-level failure — retry on a later sync
        }
        if (!ok) {
          store.appendSyncLog({
            relay: base,
            phase: "purge",
            result: "fail",
            message: `stream compaction not acked (${batch.length} streams)`,
          });
          break; // don't hammer a failing relay with the remaining batches
        }
        for (const e of batch) {
          store.ackPurgeBase(e.table, e.rowId, base);
          e.ackedBases.push(base);
        }
      }
    }
    for (const e of withIds) {
      if (bases.every((b) => e.ackedBases.includes(b))) {
        store.dropPurgeEntry(e.table, e.rowId);
      }
    }
  };

  // Returns true when the row was written, false when the local copy wins (LWW).
  const applyRemoteRow = (
    payload: SyncPayload<Record<string, unknown>>,
  ): boolean => {
    const { driver } = state;
    if (!driver) return false;
    const existing = driver.select<{ updatedAt: string }>(
      `select updatedAt from "${payload.table}" where id = ?`,
      [payload.rowId],
    )[0];
    if (existing && compareHlc(existing.updatedAt, payload.hlc) >= 0)
      return false;
    // Project onto the local schema before writing: a device on an older app
    // version can pull a row a newer version wrote with a column it doesn't
    // know about yet. Writing the raw value straight to writeRow would throw
    // ("no column named ...") — and since that throw used to be caught while
    // the event was still marked seen unconditionally below, the whole row
    // was lost permanently, not just the new column (Plan 004). Unknown
    // columns are silently dropped here, matching the additive-migration
    // convention (ensureSchema, wire-compatibility note above).
    const { row: projected, error } = store.projectRow(payload.table, {
      ...payload.value,
      id: payload.rowId,
    });
    if (error) throw new Error(error);
    store.writeRow(payload.table, projected);
    return true;
  };

  interface PullResult {
    changed: Set<string>;
    pulled: number;
    applied: number;
    decryptFailures: number;
    applyFailures: number;
  }

  const pullAndApply = async (baseUrl: string): Promise<PullResult> => {
    const result: PullResult = {
      changed: new Set<string>(),
      pulled: 0,
      applied: 0,
      decryptFailures: 0,
      applyFailures: 0,
    };
    const { identity, driver } = state;
    if (!identity || !driver) return result;
    const cursorKey = `cursor:${baseUrl}`;
    const after = store.getMeta(cursorKey) ?? "";
    const url = new URL(`${baseUrl}/v1/events`);
    url.searchParams.set("ownerId", identity.ownerId);
    url.searchParams.set("after", after);
    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${identity.relayAuth}` },
    });
    if (!response.ok) throw httpError("pull", response.status);
    const body = (await response.json()) as {
      events: SyncEnvelope[];
      nextCursor: string;
    };
    result.pulled = body.events.length;

    // Async phase: decrypt every not-yet-seen envelope into memory. No writes
    // happen here. decryptEnvelope is async and driver.transaction below runs
    // its callback synchronously (no await allowed inside it), so all
    // decryption must finish before that transaction opens.
    const decrypted: Array<{
      eventId: string;
      payload: SyncPayload<Record<string, unknown>>;
    }> = [];
    for (const envelope of body.events) {
      const seen = driver.select(
        `select 1 from "${SYNC_SEEN_TABLE}" where event_id = ?`,
        [envelope.eventId],
      );
      if (seen.length > 0) continue;
      let payload: SyncPayload<Record<string, unknown>>;
      try {
        payload = await decryptEnvelope<Record<string, unknown>>(
          identity,
          envelope,
        );
      } catch {
        // A bad envelope shouldn't wedge the batch — count it and move on.
        result.decryptFailures += 1;
        continue;
      }
      // Absorb every event's time into our clock (even tables we don't apply)
      // so future local writes always sort above what we've already seen.
      // observeHlc is itself synchronous (in-memory update + a couple of plain
      // setMeta writes), so doing it here rather than inside the transaction
      // below is a style choice, not a correctness requirement — it must run
      // for every decrypted event regardless of apply outcome, which this
      // preserves.
      clock.observeHlc(payload.hlc);
      // Collect for the batched sync phase below. The apply itself (via
      // applyRemoteRow, which projects onto the local schema per plan 004) and
      // the seen-insert happen inside ONE transaction there (plan 008). A
      // genuine write error is caught there, counted as applyFailures, and the
      // event is still marked seen (terminal) so it can't wedge the cursor.
      decrypted.push({ eventId: envelope.eventId, payload });
    }

    // Sync phase: apply every decrypted row and record it as seen inside ONE
    // transaction, so a big page commits once instead of ~2-3x per event.
    // Everything here is a plain synchronous driver call (select/exec) —
    // nothing async runs inside the transaction callback.
    if (decrypted.length > 0) {
      driver.transaction(() => {
        for (const { eventId, payload } of decrypted) {
          // Re-check "seen" here (not just in the async phase above): a
          // duplicate eventId within the same page — which a relay shouldn't
          // send, but we stay defensive — would otherwise be applied twice.
          const stillUnseen =
            driver.select(
              `select 1 from "${SYNC_SEEN_TABLE}" where event_id = ?`,
              [eventId],
            ).length === 0;
          if (!stillUnseen) continue;
          if (payload.table in schema) {
            try {
              if (applyRemoteRow(payload)) result.applied += 1;
              result.changed.add(payload.table);
            } catch {
              result.applyFailures += 1;
            }
          }
          driver.exec(
            `insert or ignore into "${SYNC_SEEN_TABLE}" (event_id) values (?)`,
            [eventId],
          );
        }
      });
    }

    // Advance the cursor only after the transaction above has committed, so a
    // crash mid-apply re-pulls (and safely re-applies — apply is idempotent)
    // the same page next time instead of silently skipping it.
    store.setMeta(cursorKey, body.nextCursor);
    return result;
  };

  const pruneSeen = () => {
    const { driver } = state;
    if (!driver) return;
    const n =
      driver.select<{ c: number }>(
        `select count(*) as c from "${SYNC_SEEN_TABLE}"`,
      )[0]?.c ?? 0;
    if (n > SEEN_CAP) {
      driver.exec(
        `delete from "${SYNC_SEEN_TABLE}" where event_id not in (select event_id from "${SYNC_SEEN_TABLE}" order by event_id desc limit ?)`,
        [SEEN_CAP],
      );
    }
  };

  const sync = async (): Promise<void> => {
    if (!state.identity || state.syncing) return;
    state.syncing = true;
    const bases = relayBaseUrls();
    // Flip the public sync state synchronously at the true start of the sync —
    // NOT after the awaited seal below — so observers (UI spinners, and tests'
    // settle() helpers) reliably see the in-flight sync instead of missing it
    // during the seal's first async tick. A seal-only sync (no relay attached)
    // deliberately doesn't surface a "syncing" state, matching prior behavior.
    if (bases.length > 0) state.setSyncState({ type: "SyncStateIsSyncing" });
    try {
      // Seal any durable, plaintext-pending outbox rows (see store.ts
      // insertPendingOutboxEvent) before anything else — regardless of
      // whether a relay is configured yet, so a write's event never sits
      // unencrypted at rest indefinitely just because no relay has been
      // attached (mirrors the old always-encrypt-on-write guarantee; only the
      // network push/pull below is relay-gated). This also covers boot: a
      // crash between a prior write and its seal is repaired by the very
      // first sync() call.
      await sealPendingOutbox();
      if (bases.length === 0) return;
      const changed = new Set<string>();
      let anySuccess = false;
      let firstFailure:
        | { kind: SyncFailureKind; status?: number; message: string }
        | undefined;
      // Contact every relay so each one's health is recorded independently
      // (per-relay log entries, not collapsed to the first failure).
      for (const base of bases) {
        try {
          const pushed = await pushOutbox(base);
          const r = await pullAndApply(base);
          for (const table of r.changed) changed.add(table);
          anySuccess = true;
          relayHealth.set(base, { lastSyncedAt: new Date().toISOString() });
          store.appendSyncLog({
            relay: base,
            phase: "sync",
            result: "ok",
            pushed,
            pulled: r.pulled,
            applied: r.applied,
          });
          // Decrypt/apply failures are non-fatal (the row is skipped) but worth
          // surfacing — they signal a key mismatch or schema drift.
          if (r.decryptFailures > 0 || r.applyFailures > 0) {
            store.appendSyncLog({
              relay: base,
              phase: "pull",
              result: "fail",
              kind: r.decryptFailures > 0 ? "decryptFailed" : "applyFailed",
              message: `decrypt: ${r.decryptFailures}, apply: ${r.applyFailures}`,
            });
          }
        } catch (caught) {
          const failure = classifyError(caught);
          if (!firstFailure) firstFailure = failure;
          relayHealth.set(base, {
            // Keep the last good sync time so "failing since when" is visible.
            lastSyncedAt: relayHealth.get(base)?.lastSyncedAt,
            lastFailure: {
              kind: failure.kind,
              message: failure.message,
              at: new Date().toISOString(),
            },
          });
          store.appendSyncLog({
            relay: base,
            phase: "sync",
            result: "fail",
            kind: failure.kind,
            message: failure.message,
          });
        }
      }
      if (changed.size > 0) queryCache.refreshQueries(changed);
      pruneSeen();
      // Drop outbox events now delivered to every relay (cursors advanced above).
      store.pruneOutbox(bases);
      // Retention sweep (at most once per PURGE_SWEEP_INTERVAL_MS): hard-delete
      // tombstones older than the retention window. Their (table, rowId) land
      // in the durable purge queue, which the drain below converts into
      // `POST /v1/streams/compact` calls — so the relays' copies shrink to
      // match the device instead of holding every ever-deleted row forever.
      if (config.tombstoneRetentionMs !== false) {
        const lastSweep = Number(store.getMeta("purge:lastSweepAt") ?? 0);
        if (
          !Number.isFinite(lastSweep) ||
          Date.now() - lastSweep >= PURGE_SWEEP_INTERVAL_MS
        ) {
          store.purgeDeleted(
            typeof config.tombstoneRetentionMs === "number"
              ? config.tombstoneRetentionMs
              : TOMBSTONE_RETENTION_MS,
            Date.now(),
          );
          store.setMeta("purge:lastSweepAt", String(Date.now()));
        }
      }
      // Drain runs every sync (not just on sweep days): manual purges
      // (purgeRows / "Delete Permanently") enqueue at any time. Best-effort by
      // design — a failed relay stays pending and is retried next sync.
      await drainPurgeQueue(bases);

      if (anySuccess || !firstFailure) {
        state.setSyncState({
          type: "SyncStateIsSynced",
          lastSyncedAt: new Date().toISOString(),
        });
        // Recovered — restore the normal poll cadence if we'd backed off.
        if (pollIntervalMs !== DEFAULT_POLL_MS) {
          pollIntervalMs = DEFAULT_POLL_MS;
          stopPolling();
          startPolling();
        }
      } else {
        const terminal = TERMINAL_KINDS.has(firstFailure.kind);
        state.setSyncState({
          type: "SyncStateIsNotSynced",
          error: firstFailure.message,
          kind: firstFailure.kind,
          terminal,
          status: firstFailure.status,
        });
        // A terminal failure (auth/quota/bad event) or rate-limit won't self-heal
        // by retrying the same batch immediately — slow the poller so it stops
        // hammering (focus/online/write still trigger an immediate retry).
        const backoff = terminal || firstFailure.kind === "rateLimited";
        if (backoff && pollIntervalMs !== BACKOFF_POLL_MS) {
          pollIntervalMs = BACKOFF_POLL_MS;
          stopPolling();
          startPolling();
        }
      }
    } finally {
      state.syncing = false;
    }
  };

  // The /v1/status response shape shared by all reference relays (Bun, Go,
  // Cloudflare). Fields we don't surface (ownerId, createdAt) are ignored.
  interface StatusResponse {
    server?: { version?: string; serverTime?: string };
    account?: {
      quotaBytes?: number;
      usedBytes?: number;
      usedPct?: number;
      headSeq?: number;
      streams?: number;
      events?: number;
    };
  }

  // One relay's status probe: GET /v1/status (auth-gated, per-owner). A 404
  // means the relay is up but this owner has never pushed to it — confirm
  // liveness via the public /health so `reachable`/`version` still report.
  const fetchRelayStatus = async (base: string): Promise<RelayStatus> => {
    const { identity } = state;
    const health = relayHealth.get(base);
    const bare: RelayStatus = { url: base, reachable: false, ...health };
    if (!identity) return bare;
    try {
      const url = new URL(`${base}/v1/status`);
      url.searchParams.set("ownerId", identity.ownerId);
      const response = await fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${identity.relayAuth}` },
      });
      if (response.status === 404) {
        const alive = await fetchImpl(`${base}/health`);
        const body = alive.ok
          ? ((await alive.json()) as { version?: string })
          : undefined;
        return { ...bare, reachable: alive.ok, version: body?.version };
      }
      if (!response.ok) throw httpError("status", response.status);
      const body = (await response.json()) as StatusResponse;
      return {
        ...bare,
        reachable: true,
        lastFailure: undefined,
        version: body.server?.version,
        usedBytes: body.account?.usedBytes,
        quotaBytes: body.account?.quotaBytes,
        usedPct: body.account?.usedPct,
        headSeq: body.account?.headSeq,
        streams: body.account?.streams,
        events: body.account?.events,
      };
    } catch (caught) {
      const failure = classifyError(caught);
      return {
        ...bare,
        reachable: false,
        lastFailure: {
          kind: failure.kind,
          message: failure.message,
          at: new Date().toISOString(),
        },
      };
    }
  };

  const getRelayStatuses = (): Promise<RelayStatus[]> =>
    Promise.all(relayBaseUrls().map(fetchRelayStatus));

  // The relay is HTTP (no server push), so poll periodically to pull remote
  // changes while transports are configured. Also synced opportunistically after
  // local writes and on web focus/online.
  const startPolling = () => {
    if (syncTimer !== null || state.transports.length === 0) return;
    syncTimer = setInterval(() => {
      void sync().catch(() => undefined);
    }, pollIntervalMs) as unknown as number;
  };
  const stopPolling = () => {
    if (syncTimer !== null) {
      clearInterval(syncTimer as unknown as ReturnType<typeof setInterval>);
      syncTimer = null;
    }
  };

  const setTransports = (next: readonly Transport[]) => {
    state.transports = [...next];
    // Drop health for relays no longer configured so statuses don't linger.
    const active = new Set(relayBaseUrls());
    for (const base of relayHealth.keys()) {
      if (!active.has(base)) relayHealth.delete(base);
    }
    if (state.transports.length > 0) {
      void sync().catch(() => undefined);
      startPolling();
    } else {
      stopPolling();
    }
  };

  return {
    sync,
    startPolling,
    stopPolling,
    setTransports,
    relayBaseUrls,
    getRelayStatuses,
  };
}
