import {
  decryptEnvelope,
  deriveStreamId,
  encryptPayload,
  SYNC_SCHEMA_VERSION,
  type SyncEnvelope,
} from "@simplysync/protocol";
import type {
  RelayStatus,
  SchemaDefinition,
  SyncEngineConfig,
  SyncFailureKind,
  Transport,
} from "../engine-types.js";
import {
  OUTBOX_PUSH_BATCH,
} from "./constants.js";
import type { QueryCache } from "./query-cache.js";
import type { EngineState } from "./state.js";
import type { Store } from "./store.js";
import type { EventAdmission } from "./admission.js";
import {
  type RuntimeSyncPayload,
} from "./schema-version.js";

export type RelaySync = ReturnType<typeof createRelaySync>;

/**
 * Relay synchronization over HTTP: push the encrypted outbox, pull + decrypt +
 * apply remote events (last-writer-wins by HLC), and poll periodically. The
 * relay only ever sees opaque envelopes — all crypto happens here on the client.
 */
export function createRelaySync(
  state: EngineState,
  store: Store,
  admission: EventAdmission,
  queryCache: QueryCache,
  schema: SchemaDefinition,
  config: SyncEngineConfig,
  fetchImpl: typeof fetch,
  schemaVersion: number = SYNC_SCHEMA_VERSION,
) {
  const DEFAULT_POLL_MS =
    typeof config.syncIntervalMs === "number" && config.syncIntervalMs > 0
      ? config.syncIntervalMs
      : 60_000;
  // Explicit-only mode (config.autoSync === false). Every automatic trigger —
  // the poll tick here, and a local write, boot, focus/online, promotion to
  // Leader from mutations-lifecycle — reaches this module through the one
  // `sync` it publishes, so suppressing that single entry covers all of them;
  // `syncNow` stays the explicit entry `engine.sync()` is bound to.
  const autoSyncEnabled = config.autoSync !== false;
  // Backoff poll interval after a terminal failure so we don't re-push a
  // rejected batch every normal poll forever (battery/network drain). focus/online and
  // local writes still trigger an immediate retry.
  const BACKOFF_POLL_MS = 5 * 60_000;
  // Cap the dedup set so it can't grow without bound. Safe to prune: the relay
  // cursor only advances, so pruned (oldest) eventIds won't be re-pulled, and
  // applyRemoteRow is idempotent (LWW) even if one were.
  const SEEN_CAP = 50_000;
  const DEFERRED_REPLAY_LIMIT = 256;
  // Single-owner mutable state (never touched outside this module).
  let syncTimer: number | null = null;
  let pollIntervalMs = DEFAULT_POLL_MS;
  // Coalesce sync requests that arrive while a pass is already in flight. In
  // particular, setTransports() can replace the startup/default relay after
  // that pass captured its base URLs; the replacement must run next instead
  // of waiting for another write, focus event, or poll tick.
  let syncQueued = false;
  // Non-null while a drain loop is running; concurrent sync() callers await it.
  let activeSync: Promise<void> | null = null;
  // Per-relay outcome of the last contact, keyed by base URL. SyncState
  // collapses multi-relay results ("synced" as long as ANY relay works — the
  // data is safe somewhere); this map keeps the per-relay truth so
  // getRelayStatuses can show which relay is failing behind a green state.
  const relayHealth = new Map<
    string,
    { lastSyncedAt?: string; lastFailure?: RelayStatus["lastFailure"] }
  >();
  // Relays that lost their data and are being re-seeded from this device. Kept
  // out of relayHealth because that entry is replaced wholesale on every
  // contact, while a re-seed deliberately spans passes: the wipe is detected
  // during pull, the rebuilt outbox drains on the following pass.
  const reseedingRelays = new Set<string>();

  // A relay whose event log is behind our pull cursor has lost data (wiped
  // volume, fresh deploy, restored from an older backup). Its `seq` counter
  // restarted, so `where seq > cursor` would match nothing and this device
  // would report "synced" forever while diverging from every peer. Forget the
  // relay, rebuild the outbox now so pendingOutboxCount reflects the re-upload
  // immediately, and flag it so a UI can say "re-uploading" instead of lying.
  const handleWipedRelay = (base: string): void => {
    if (reseedingRelays.has(base)) return;
    reseedingRelays.add(base);
    store.resetRelaySyncState(base);
    store.backfillOutboxForNewRelay(base);
    store.appendSyncLog({
      relay: base,
      phase: "pull",
      result: "fail",
      kind: "serverError",
      message: "relay lost its data - re-uploading from this device",
    });
  };

  const httpError = (op: string, status: number): Error => {
    const err = new Error(`${op} failed: ${status}`) as Error & {
      status?: number;
    };
    err.status = status;
    return err;
  };

  // A 200 whose body is not a pull page. Classified as the relay's fault rather
  // than falling through to "unreachable", which a UI reads as being offline.
  const malformedResponse = (op: string): Error => {
    const err = new Error(`${op} returned a malformed response`) as Error & {
      kind?: SyncFailureKind;
    };
    err.kind = "serverError";
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
    const preclassified = (caught as { kind?: SyncFailureKind } | undefined)
      ?.kind;
    if (preclassified) return { kind: preclassified, message };
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

  // The base URL is also the per-relay `_sync_meta` key, so two spellings of
  // one relay would be two relays: a trailing slash split the cursor and made
  // every request hit `//v1/...`, which the reference relays do not route. The
  // native ports already strip it; this keeps the three engines on one key.
  const relayBaseUrls = (): string[] =>
    state.transports.map((t) =>
      t.url
        .replace(/^wss:\/\//u, "https://")
        .replace(/^ws:\/\//u, "http://")
        .replace(/\/+$/u, ""),
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
    for (const row of store.listUnsealedOutbox()) {
      try {
        const payload = JSON.parse(row.payloadJson) as RuntimeSyncPayload;
        const envelope = await encryptPayload(
          identity,
          { eventId: row.eventId, deviceId: state.deviceId },
          payload,
        );
        store.sealOutboxEvent(row.eventId, JSON.stringify(envelope));
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
    const events = store.claimPushBatch(baseUrl);
    if (events.length === 0) return 0;
    const response = await fetchImpl(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${identity.relayAuth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ownerId: identity.ownerId,
        events: events.map((e) => JSON.parse(e.envelopeJson)),
      }),
    });
    if (!response.ok) throw httpError("push", response.status);
    // The owner changed while this request was in flight (restore/reset wiped
    // the outbox). Recording delivery now would write the OLD owner's push
    // cursor into the NEW owner's metadata, which skips its first backfill.
    if (state.identity !== identity) return 0;
    store.markBatchDelivered(
      events.map((e) => e.eventId),
      baseUrl,
      new Date().toISOString(),
    );
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

  type DeferredRow = { eventId: string; payloadJson: string };

  // Apply one bounded page. Opaque schema/table rows stay marked with a NULL
  // retry time and are considered only by the once-per-boot cursor scan.
  // Future-clock rows carry their earliest admissible wall time and are the
  // only rows selected by normal sync passes.
  const replayDeferredRows = (staged: readonly DeferredRow[]): Set<string> => {
    const changed = new Set<string>();
    const { driver } = state;
    if (!driver || staged.length === 0) return changed;
    driver.transaction(() => {
      for (const row of staged) {
        let rawPayload: unknown;
        try {
          rawPayload = JSON.parse(row.payloadJson) as unknown;
        } catch {
          store.dropDeferredEvent(row.eventId);
          continue;
        }
        const outcome = admission.admit(row.eventId, rawPayload, row.payloadJson);
        if (outcome.kind === "applied") changed.add(outcome.table);
      }
    });
    if (changed.size > 0) queryCache.refreshQueries(changed);
    return changed;
  };

  // Sweep every opaque row once per boot, paged so a large backlog never does
  // launch-long work in one transaction. A row this schema can now interpret
  // applies and leaves the queue; the rest stay opaque until a future upgrade.
  // ponytail: rescans permanently-opaque rows on every boot; bring back a
  // durable per-schema cursor if a large opaque backlog ever shows up in boot
  // profiles.
  const replayOpaqueBacklog = (): Set<string> => {
    const changed = new Set<string>();
    let cursor: string | null = null;
    while (true) {
      const page = store.listOpaqueDeferredEvents(cursor, DEFERRED_REPLAY_LIMIT);
      if (page.length === 0) break;
      for (const table of replayDeferredRows(page)) changed.add(table);
      if (page.length < DEFERRED_REPLAY_LIMIT) break;
      cursor = page[page.length - 1]!.eventId;
    }
    return changed;
  };

  const replayDeferredAtBoot = async (): Promise<Set<string>> => {
    const changed = replayOpaqueBacklog();
    for (const table of replayDueDeferred()) changed.add(table);
    return changed;
  };

  const replayDueDeferred = (): Set<string> =>
    replayDeferredRows(
      store.listDueDeferredEvents(Date.now(), DEFERRED_REPLAY_LIMIT),
    );

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
    const after = store.pullCursor(baseUrl) ?? "";
    const url = new URL(`${baseUrl}/v1/events`);
    url.searchParams.set("ownerId", identity.ownerId);
    url.searchParams.set("after", after);
    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${identity.relayAuth}` },
    });
    // An owner the relay has never seen is "nothing to pull yet", not an error.
    // Both reference relays create the owner on PUSH only, so pull/status 404
    // until this account's first event lands (relay-go store.go `Unknown owner`,
    // relay-cloudflare `createIfMissing: false`) — and getRelayStatuses already
    // reads that 404 as "relay up, account empty". Classifying it as a failure
    // instead made every fresh install report a TERMINAL sync error and back the
    // poller off to 5 minutes until its first write. A wrong base URL still
    // surfaces: push creates the owner, so it 404s there and stays terminal.
    // A 404 for an owner we have ALREADY pulled from is different in kind: the
    // relay didn't just miss our first push, it lost the account. Repair rather
    // than treat it as "nothing to pull yet", or the stale cursor stalls sync
    // permanently once the relay's seq counter restarts below it.
    if (response.status === 404) {
      if (after !== "") handleWipedRelay(baseUrl);
      return result;
    }
    if (!response.ok) throw httpError("pull", response.status);
    const body = (await response.json()) as {
      events?: unknown;
      nextCursor?: unknown;
    };
    if (!Array.isArray(body.events) || typeof body.nextCursor !== "string") {
      throw malformedResponse("pull");
    }
    const events = body.events as SyncEnvelope[];
    const nextCursor = body.nextCursor;
    result.pulled = events.length;

    // Async phase: decrypt every not-yet-seen envelope into memory. No writes
    // happen here. decryptEnvelope is async and driver.transaction below runs
    // its callback synchronously (no await allowed inside it), so all
    // decryption must finish before that transaction opens.
    const decrypted: Array<{
      eventId: string;
      payloadJson: string;
      rawPayload: unknown;
    }> = [];
    for (const envelope of events) {
      if (store.hasSeenEvent(envelope.eventId)) continue;
      let rawPayload: unknown;
      try {
        rawPayload = await decryptEnvelope<unknown, number>(
          identity,
          envelope,
        );
      } catch {
        // A bad envelope shouldn't wedge the batch — count it and move on.
        result.decryptFailures += 1;
        continue;
      }
      // Decryption is the only asynchronous step, so it is the only one that
      // has to happen out here. Every decision about the event — classifying
      // it, ordering it, absorbing its clock, applying or deferring it — runs
      // inside the transaction below, through the same admission ladder the
      // replay and cross-tab paths use.
      decrypted.push({
        eventId: envelope.eventId,
        payloadJson: JSON.stringify(rawPayload),
        rawPayload,
      });
    }

    // Every await above is a window in which restoreAppOwner / resetAppOwner /
    // importDatabase can swap the owner and wipe the database. This page was
    // fetched and decrypted for the previous owner: applying it now would leak
    // that owner's rows into the new owner's database, and advancing the
    // cursor would make the new owner's first pull skip everything below it.
    // Drop the page; the pass the switch queued re-pulls under the new owner.
    if (state.identity !== identity) return result;

    // Sync phase: apply every decrypted row and record it as seen inside ONE
    // transaction, so a big page commits once instead of ~2-3x per event.
    // Everything here is a plain synchronous driver call (select/exec) —
    // nothing async runs inside the transaction callback.
    if (decrypted.length > 0) {
      driver.transaction(() => {
        for (const { eventId, payloadJson, rawPayload } of decrypted) {
          // Re-check "seen" here (not just in the async phase above): a
          // duplicate eventId within the same page — which a relay shouldn't
          // send, but we stay defensive — would otherwise be applied twice.
          if (store.hasSeenEvent(eventId)) continue;
          const outcome = admission.admit(eventId, rawPayload, payloadJson);
          if (outcome.kind === "applied" || outcome.kind === "unchanged") {
            result.changed.add(outcome.table);
            if (outcome.kind === "applied") result.applied += 1;
          } else if (
            outcome.kind === "rejected"
            || outcome.reason === "applyFailed"
          ) {
            // Rejected events are unorderable or not payloads at all, and are
            // gone. An `applyFailed` deferral is retained, not lost — but it
            // still means a row this build could not write, so it stays
            // visible in the sync log rather than being retained silently.
            result.applyFailures += 1;
          }
          // A deferred event is retained in its own queue and replayed later;
          // marking it seen only stops the relay re-delivering it.
          store.markEventSeen(eventId);
        }
      });
    }

    // Advance the cursor only after the transaction above has committed, so a
    // crash mid-apply re-pulls (and safely re-applies — apply is idempotent)
    // the same page next time instead of silently skipping it.
    // An idle poll commonly returns the cursor we already have. Avoid turning
    // that no-op into a database write (and, in browsers, a whole-db snapshot).
    if (nextCursor !== after) {
      store.setPullCursor(baseUrl, nextCursor);
    }
    return result;
  };

  const pruneSeen = () => store.pruneSeen(SEEN_CAP);

  const runSyncPass = async (): Promise<void> => {
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
      // A quarantined future HLC becomes admissible as wall time advances;
      // normal syncs select only a bounded due-clock page. Opaque rows are
      // only reconsidered by the boot sweep above.
      replayDueDeferred();
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
          // If this relay was added after the bounded outbox was pruned, rebuild
          // the current row state before its first push.
          store.backfillOutboxForNewRelay(base);
          // Seals what that backfill just queued. The pass-level seal above
          // ran before these rows existed, and a backfilled row must be sealed
          // before it can be pushed — so this is a no-op on every relay that
          // was not just re-seeded, not a redundant second pass.
          await sealPendingOutbox();
          // Drain within THIS sync (plan 008 step 2): a big backlog (e.g. a
          // new-relay backfill) must not trickle out one batch per poll cycle,
          // flashing a misleading "synced" between batches while thousands of
          // events are still pending. Re-emit SyncStateIsSyncing with live
          // counters per batch/page so subscribers can show real movement.
          let pushed = 0;
          let pulled = 0;
          let applied = 0;
          const emitProgress = () =>
            state.setSyncState({
              type: "SyncStateIsSyncing",
              progress: {
                pendingPush: store.pendingOutboxCount(),
                pulled,
                applied,
              },
            });
          while (true) {
            const batch = await pushOutbox(base);
            pushed += batch;
            if (batch > 0) emitProgress();
            // Partial batch = outbox drained. Full means the Store capped it.
            if (batch < OUTBOX_PUSH_BATCH) break;
          }
          // Nothing left to send means the post-wipe re-seed has landed and
          // this relay holds a full copy again. Checked after the drain, so the
          // pass that detects the wipe (push runs before pull) can't clear it.
          if (pushed === 0) reseedingRelays.delete(base);
          const r: PullResult = {
            changed,
            pulled: 0,
            applied: 0,
            decryptFailures: 0,
            applyFailures: 0,
          };
          let firstPage = true;
          while (true) {
            const cursorBefore = store.pullCursor(base) ?? "";
            const page = await pullAndApply(base);
            const advanced = (store.pullCursor(base) ?? "") !== cursorBefore;
            // Forward-progress guard: a non-empty page that didn't advance the
            // cursor is the relay re-serving events we already have. The FIRST
            // page of a sync still counts (a resend is real pull traffic and
            // the sync log should say so — "pulled N, applied 0"), but a
            // repeat mid-drain is double counting, and looping on it would
            // spin forever; stop and let the next poll retry from the cursor.
            if (!firstPage && page.pulled > 0 && !advanced) break;
            for (const table of page.changed) changed.add(table);
            r.pulled += page.pulled;
            r.applied += page.applied;
            r.decryptFailures += page.decryptFailures;
            r.applyFailures += page.applyFailures;
            pulled = r.pulled;
            applied = r.applied;
            firstPage = false;
            if (page.pulled === 0) break;
            if (!advanced) break; // counted once — don't spin on a stuck cursor
            emitProgress();
          }
          anySuccess = true;
          relayHealth.set(base, { lastSyncedAt: new Date().toISOString() });
          // Keep diagnostics useful without writing an identical success row on
          // every idle poll. Browser drivers snapshot after writes, so logging
          // zero activity here otherwise creates periodic main-thread jank.
          if (pushed > 0 || r.pulled > 0 || r.applied > 0) {
            store.appendSyncLog({
              relay: base,
              phase: "sync",
              result: "ok",
              pushed,
              pulled: r.pulled,
              applied: r.applied,
            });
          }
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
      // Do not hard-delete synced tombstones here. Until the protocol has a
      // durable cross-device delete watermark, a device that was offline past a
      // retention window could return with an older live row after both the
      // online tombstone and relay stream had been erased. The public purge APIs
      // apply the same safety rule while transports are configured.
      //
      // Keep draining entries written by older app versions so an upgrade does
      // not strand compactions that were already requested. A failed relay stays
      // pending and is retried on the next sync.
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
    } catch (caught) {
      // Per-relay failures are handled above; this is a fault outside them (a
      // deferred replay or prune hitting a full disk, say). Observers were told
      // a sync began, so tell them it ended — otherwise the spinner stays on
      // until the next poll happens to succeed.
      if (bases.length > 0) {
        state.setSyncState({
          type: "SyncStateIsNotSynced",
          error: caught instanceof Error ? caught.message : String(caught),
          kind: "unknown",
          terminal: false,
        });
      }
      throw caught;
    } finally {
      state.syncing = false;
    }
  };

  // Drains passes until nothing more is queued. Owned by whichever sync() call
  // started it; concurrent callers await the same promise. Clear activeSync
  // here, in the same synchronous turn as the final queue check, so there is no
  // window where a new caller can attach to a drain that has already decided to
  // stop.
  const drainSyncPasses = async (): Promise<void> => {
    let firstError: unknown;
    let failed = false;
    do {
      syncQueued = false;
      try {
        await runSyncPass();
      } catch (caught) {
        // A transport replacement must still get its prompt pass even if the
        // pass it superseded failed before reaching the per-relay error guard.
        // Preserve the first rejection for the original caller after draining.
        if (!failed) {
          failed = true;
          firstError = caught;
        }
      }
    } while (syncQueued && state.identity);

    activeSync = null;
    if (failed) throw firstError;
  };

  const sync = (): Promise<void> => {
    // An identity-less engine cannot seal or authenticate; this also keeps a
    // queued pass from running after identity changes while the preceding
    // pass was in flight.
    if (!state.identity) return Promise.resolve();

    // A pass is already in flight (commonly the background poller). Queue a
    // follow-up so THIS caller's writes are pushed, then resolve only once the
    // drain finishes: `await sync()` has to mean "a sync covering my writes
    // completed", not "a sync was requested". Returning early here silently
    // no-ops every scripted push/pull that races the poller.
    //
    // One shared drain promise means concurrent callers coalesce into a single
    // follow-up pass instead of creating one relay round-trip per caller.
    if (activeSync) {
      syncQueued = true;
      return activeSync;
    }

    const started = drainSyncPasses();
    activeSync = started;
    return started;
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
    const bare: RelayStatus = {
      url: base,
      reachable: false,
      ...health,
      reseeding: reseedingRelays.has(base) || undefined,
    };
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
      // The relay still knows the owner but holds nothing for it while we have
      // pulled from it before: it was truncated or restored from an older
      // backup, which the pull 404 above can't see because the owner row
      // survived. `events === 0` is required as well as a `headSeq` behind our
      // cursor — stream compaction legitimately lowers `max(seq)` over
      // surviving rows, and treating that as data loss would trigger a pointless
      // full re-seed on every healthy relay that compacts. The cost is that a
      // PARTIAL restore (some events left) isn't detected here; a legacy HLC
      // cursor parses to NaN and is correctly ignored.
      const localCursor = Number(store.pullCursor(base) ?? "0");
      if (
        body.account?.headSeq !== undefined &&
        Number.isFinite(localCursor) &&
        body.account.headSeq < localCursor &&
        (body.account.events ?? 0) === 0
      ) {
        handleWipedRelay(base);
      }
      return {
        ...bare,
        reachable: true,
        lastFailure: undefined,
        reseeding: reseedingRelays.has(base) || undefined,
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
    if (!autoSyncEnabled) return;
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

  const autoSync = (): Promise<void> =>
    autoSyncEnabled ? sync() : Promise.resolve();

  const setTransports = (next: readonly Transport[]) => {
    state.transports = [...next];
    // Drop health for relays no longer configured so statuses don't linger.
    const active = new Set(relayBaseUrls());
    for (const base of relayHealth.keys()) {
      if (!active.has(base)) relayHealth.delete(base);
    }
    for (const base of reseedingRelays) {
      if (!active.has(base)) reseedingRelays.delete(base);
    }
    if (state.transports.length > 0) {
      void autoSync().catch(() => undefined);
      startPolling();
    } else {
      stopPolling();
    }
  };

  return {
    // What every automatic trigger calls, and the one place explicit-only mode
    // has to switch off.
    sync: autoSync,
    /** The explicit entry: `engine.sync()` runs a pass whatever the mode. */
    syncNow: sync,
    startPolling,
    stopPolling,
    setTransports,
    relayBaseUrls,
    getRelayStatuses,
    replayDeferredAtBoot,
    replayDueDeferred,
  };
}
