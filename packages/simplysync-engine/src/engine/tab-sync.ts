import { SYNC_SCHEMA_VERSION } from "@simplysync/protocol";
import type { SchemaDefinition, TabSync, TabSyncEvent } from "../engine-types.js";
import type { QueryCache } from "./query-cache.js";
import type { EngineState } from "./state.js";
import type { Clock, Store } from "./store.js";
import { classifySyncPayload } from "./schema-version.js";

export type TabBridge = ReturnType<typeof createTabBridge>;

// BroadcastChannel messages are structured-cloned whole; keep one message
// comfortably small even for a bulk import's batch.
const PUBLISH_CHUNK = 500;

/**
 * The engine side of cross-tab replication. Every committed event (a local
 * write, a relay-pulled row, a replayed deferred event) is published to the
 * other tabs; events received from them are applied through the same LWW path
 * a relay pull uses (observeHlc + applyLwwRow), then staged in this tab's
 * outbox too — so whichever tab is later promoted to leader can push the
 * fleet's complete backlog, not just its own writes.
 *
 * Subscribes at construction (before the database is open) and buffers until
 * `start()`, so a follower can never miss an event broadcast while its
 * snapshot is still loading; the overlap between the loaded snapshot and the
 * buffer resolves itself because apply is LWW-idempotent.
 */
export function createTabBridge(
  state: EngineState,
  store: Store,
  clock: Clock,
  queryCache: QueryCache,
  schema: SchemaDefinition,
  tabSync: TabSync | undefined,
  schemaVersion: number = SYNC_SCHEMA_VERSION,
) {
  let started = false;
  const buffer: TabSyncEvent[] = [];

  const bridge = {
    // Assigned during engine assembly (relay is constructed after this
    // module): lets the leader push promptly when a follower's write arrives
    // instead of waiting for the next poll tick.
    onApplied: undefined as ((stagedOutbox: boolean) => void) | undefined,

    publish(events: readonly TabSyncEvent[]): void {
      if (!tabSync || events.length === 0) return;
      for (let i = 0; i < events.length; i += PUBLISH_CHUNK) {
        tabSync.publishEvents(events.slice(i, i + PUBLISH_CHUNK));
      }
    },

    start(): void {
      if (!tabSync || started) return;
      started = true;
      if (buffer.length > 0) {
        const pending = buffer.splice(0);
        apply(pending);
      }
    },
  };

  const apply = (events: readonly TabSyncEvent[]): void => {
    const { driver } = state;
    if (!driver) return;
    const changed = new Set<string>();
    let stagedOutbox = false;
    driver.transaction(() => {
      for (const event of events) {
        let rawPayload: unknown;
        try {
          rawPayload = JSON.parse(event.payloadJson) as unknown;
        } catch {
          continue;
        }
        const classified = classifySyncPayload(rawPayload, schemaVersion);
        if (classified.kind === "invalid") continue;
        const payload = classified.kind === "supported"
          ? classified.payload
          : null;
        // Absorb the sender's time so this tab's next write sorts above it.
        if (payload && !clock.observeHlc(payload.hlc)) continue;
        // Tabs run the same page, hence the same schema — no deferred-event
        // staging is normally needed here. During a rolling page upgrade an
        // older leader can still receive a future payload from a newer
        // follower: don't apply it, but retain its outbox marker below so the
        // event can still reach the relay.
        if (payload && payload.table in schema) {
          try {
            if (store.applyLwwRow(payload)) changed.add(payload.table);
          } catch {
            continue; // one bad event must not wedge the batch
          }
        }
        if (event.outbox) {
          store.insertPendingOutboxEvent(event.eventId, event.payloadJson);
          stagedOutbox = true;
        }
      }
    });
    if (changed.size > 0) queryCache.refreshQueries(changed);
    if (stagedOutbox) bridge.onApplied?.(stagedOutbox);
  };

  tabSync?.subscribeEvents((events) => {
    if (started) apply(events);
    else buffer.push(...events);
  });

  return bridge;
}
