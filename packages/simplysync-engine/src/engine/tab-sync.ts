import type { TabSync, TabSyncEvent } from "../engine-types.js";
import type { QueryCache } from "./query-cache.js";
import type { EngineState } from "./state.js";
import type { Store } from "./store.js";
import type { EventAdmission } from "./admission.js";

export type TabBridge = ReturnType<typeof createTabBridge>;

// BroadcastChannel messages are structured-cloned whole; keep one message
// comfortably small even for a bulk import's batch.
const PUBLISH_CHUNK = 500;

/**
 * The engine side of cross-tab replication. Every committed event (a local
 * write, a relay-pulled row, a replayed deferred event) is published to the
 * other tabs; events received from them go through the same admission ladder
 * a relay pull uses, then are staged in this tab's outbox too — so whichever
 * tab is later promoted to leader can push the fleet's complete backlog, not
 * just its own writes.
 *
 * Subscribes at construction (before the database is open) and buffers until
 * `start()`, so a follower can never miss an event broadcast while its
 * snapshot is still loading; the overlap between the loaded snapshot and the
 * buffer resolves itself because apply is LWW-idempotent.
 */
export function createTabBridge(
  state: EngineState,
  store: Store,
  admission: EventAdmission,
  queryCache: QueryCache,
  tabSync: TabSync | undefined,
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
        // The same ladder the relay-pull and deferred-replay paths use: a tab
        // broadcast is the same event arriving at another database, so it must
        // reach the same verdict. Tabs normally run the same page and the
        // event just applies; during a rolling upgrade an older tab can
        // receive a payload it cannot interpret, and admission retains it
        // rather than discarding it.
        const outcome = admission.admit(
          event.eventId,
          rawPayload,
          event.payloadJson,
        );
        if (outcome.kind === "applied") changed.add(outcome.table);
        // Staging is independent of whether this tab could apply the event.
        // The marker exists so whichever tab is promoted can push the fleet's
        // backlog, and an event this tab merely deferred is still an event the
        // relay has never seen. Only a structurally rejected event is dropped:
        // it can never become pushable.
        if (event.outbox && outcome.kind !== "rejected") {
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
