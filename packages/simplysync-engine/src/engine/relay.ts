import {
  compareHlc,
  decryptEnvelope,
  type SyncEnvelope,
  type SyncPayload,
} from "@simplysync/protocol";
import type {
  SchemaDefinition,
  SyncEngineConfig,
  SyncEngineDeps,
  Transport,
} from "../engine-types";
import { SYNC_OUTBOX_TABLE, SYNC_SEEN_TABLE } from "./constants";
import type { QueryCache } from "./query-cache";
import type { EngineState } from "./state";
import type { Store } from "./store";

export type RelaySync = ReturnType<typeof createRelaySync>;

/**
 * Relay synchronization over HTTP: push the encrypted outbox, pull + decrypt +
 * apply remote events (last-writer-wins by HLC), and poll periodically. The
 * relay only ever sees opaque envelopes — all crypto happens here on the client.
 */
export function createRelaySync(
  state: EngineState,
  store: Store,
  queryCache: QueryCache,
  schema: SchemaDefinition,
  deps: SyncEngineDeps,
  config: SyncEngineConfig,
  fetchImpl: typeof fetch,
) {
  // Relay HTTP errors carry their status so sync() can tell a retryable failure
  // (network / 5xx / 429) from a terminal one (400/401/403/413).
  const TERMINAL_STATUSES = new Set([400, 401, 403, 413]);
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

  const httpError = (op: string, status: number): Error => {
    const err = new Error(`${op} failed: ${status}`) as Error & {
      status?: number;
    };
    err.status = status;
    return err;
  };

  const relayBaseUrls = (): string[] =>
    state.transports.map((t) =>
      t.url.replace(/^wss:\/\//u, "https://").replace(/^ws:\/\//u, "http://"),
    );

  const pushOutbox = async (baseUrl: string): Promise<void> => {
    const { identity, driver } = state;
    if (!identity || !driver) return;
    const events = driver.select<{ event_id: string; envelope_json: string }>(
      `select event_id, envelope_json from "${SYNC_OUTBOX_TABLE}" where pushed_at is null order by event_id asc limit 1000`,
    );
    if (events.length === 0) return;
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
    for (const event of events) {
      driver.exec(
        `update "${SYNC_OUTBOX_TABLE}" set pushed_at = ? where event_id = ?`,
        [pushedAt, event.event_id],
      );
    }
  };

  const applyRemoteRow = (payload: SyncPayload<Record<string, unknown>>) => {
    const { driver } = state;
    if (!driver) return;
    const existing = driver.select<{ updatedAt: string }>(
      `select updatedAt from "${payload.table}" where id = ?`,
      [payload.rowId],
    )[0];
    if (existing && compareHlc(existing.updatedAt, payload.hlc) >= 0) return;
    store.writeRow(payload.table, { ...payload.value, id: payload.rowId });
  };

  const pullAndApply = async (baseUrl: string): Promise<Set<string>> => {
    const changed = new Set<string>();
    const { identity, driver } = state;
    if (!identity || !driver) return changed;
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
    for (const envelope of body.events) {
      const seen = driver.select(
        `select 1 from "${SYNC_SEEN_TABLE}" where event_id = ?`,
        [envelope.eventId],
      );
      if (seen.length > 0) continue;
      const payload = await decryptEnvelope<Record<string, unknown>>(
        identity,
        envelope,
      );
      if (payload.table in schema) {
        applyRemoteRow(payload);
        changed.add(payload.table);
      }
      driver.exec(
        `insert or ignore into "${SYNC_SEEN_TABLE}" (event_id) values (?)`,
        [envelope.eventId],
      );
    }
    store.setMeta(cursorKey, body.nextCursor);
    return changed;
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
    const bases = relayBaseUrls();
    if (bases.length === 0) return;
    state.syncing = true;
    state.setSyncState({ type: "SyncStateIsSyncing" });
    try {
      const changed = new Set<string>();
      for (const base of bases) {
        await pushOutbox(base);
        for (const table of await pullAndApply(base)) changed.add(table);
      }
      if (changed.size > 0) queryCache.refreshQueries(changed);
      pruneSeen();
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
    } catch (caught) {
      const status = (caught as { status?: number } | undefined)?.status;
      const terminal =
        typeof status === "number" && TERMINAL_STATUSES.has(status);
      state.setSyncState({
        type: "SyncStateIsNotSynced",
        error: caught instanceof Error ? caught.message : String(caught),
        terminal,
        status,
      });
      // A terminal failure (auth/quota/bad event) won't self-heal by retrying
      // the same batch — slow the poller so it stops hammering, but keep
      // retrying occasionally (and immediately on focus/online/write).
      if (terminal && pollIntervalMs !== BACKOFF_POLL_MS) {
        pollIntervalMs = BACKOFF_POLL_MS;
        stopPolling();
        startPolling();
      }
    } finally {
      state.syncing = false;
    }
  };

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
    if (state.transports.length > 0) {
      void sync().catch(() => undefined);
      startPolling();
    } else {
      stopPolling();
    }
  };

  return { sync, startPolling, stopPolling, setTransports, relayBaseUrls };
}
