import type { SyncState, TabSync, TabSyncEvent } from "@simplysync/engine";
import { persistNow } from "./sql-js-driver.js";

// The coordinator is the browser implementation of the engine's TabSync
// contract plus the persistence-side coordination the sql.js driver needs:
// every tab applies every other tab's events (engine side), while exactly one
// tab — the holder of the same Web Lock the driver used to fail fast on —
// persists snapshots and syncs with relays. Leadership transfers by lock
// grant when the leader closes; the promoted tab immediately persists its
// in-memory state (snapshot + every applied broadcast), which heals whatever
// the dead leader hadn't persisted yet.

type TabMessage =
  | { readonly t: "events"; readonly events: TabSyncEvent[] }
  | { readonly t: "sync-state"; readonly state: SyncState }
  | { readonly t: "persist-req"; readonly reqId: string }
  | { readonly t: "persist-ack"; readonly reqId: string }
  | { readonly t: "shutdown"; readonly from: string };

/** Minimal BroadcastChannel surface (test seam). */
export interface TabChannel {
  postMessage(data: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/** Minimal queued-exclusive Web Locks surface (test seam). */
export interface TabLockManager {
  request(
    name: string,
    options: { mode: "exclusive"; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

export interface TabCoordinatorOptions {
  readonly databaseName: string;
  /**
   * Invoked when another tab runs a destructive operation (owner restore or
   * reset, database import) and this tab must reboot from the replacement
   * snapshot. Default: `location.reload()`.
   */
  readonly onShutdown?: () => void;
  /** Test seams. */
  readonly channel?: TabChannel | null;
  readonly locks?: TabLockManager | null;
  readonly persist?: (name: string) => Promise<void>;
}

export interface TabCoordinator extends TabSync {
  /**
   * True when both BroadcastChannel and Web Locks exist. When false the
   * coordinator is inert (sole-leader) and the sql.js driver falls back to
   * its legacy fail-fast writer lock — exactly the pre-coordinator behavior.
   */
  isCoordinating(): boolean;
  /**
   * Follower boot barrier: resolves once the current leader has persisted a
   * fresh snapshot (so the follower loads current data, not a stale save) —
   * or once this tab is promoted, meaning no leader existed. No timeouts:
   * the request re-broadcasts until one of the two happens.
   */
  ensureFreshSnapshot(): Promise<void>;
  /**
   * Ask the leader to persist on this tab's behalf (follower `persistNow`).
   * Resolves true when the leader acked, false when this tab got promoted
   * while waiting (the caller should then persist locally).
   */
  requestPersist(): Promise<boolean>;
  /** Release the lock and channel (tests). */
  close(): void;
}

const randomTag = (): string => {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36)).join("");
};

export function createTabCoordinator(
  options: TabCoordinatorOptions,
): TabCoordinator {
  const name = options.databaseName;
  const tabId = randomTag();
  const locks =
    options.locks !== undefined
      ? options.locks
      : ((globalThis.navigator as { locks?: TabLockManager } | undefined)
          ?.locks ?? null);
  const channel =
    options.channel !== undefined
      ? options.channel
      : typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(`simplysync-tabs:${name}`)
        : null;
  const persist = options.persist ?? ((n: string) => persistNow(n));
  const coordinating = locks !== null && channel !== null;

  let leader = !coordinating; // inert mode: sole leader, everything no-ops
  let exclusive = false; // this tab is running a destructive op
  let shuttingDown = false;
  let releaseHeld: (() => void) | null = null;
  const leaderAbort = new AbortController();

  // Internal listeners always fire on promotion (boot barrier, exclusive-op
  // wait); public ones (the engine starting relay sync) are suppressed while
  // this tab runs a destructive op — it is about to replace the database and
  // reload, so spinning up sync against the doomed state helps nobody.
  const internalPromoted = new Set<() => void>();
  const publicPromoted = new Set<() => void>();
  const eventListeners = new Set<(events: readonly TabSyncEvent[]) => void>();
  const syncStateListeners = new Set<(state: SyncState) => void>();
  const persistWaiters = new Map<string, () => void>();
  let reqSeq = 0;

  const post = (message: TabMessage): void => channel?.postMessage(message);

  const firePromoted = (): void => {
    // Copy first: listeners remove themselves (one-shot waiters) mid-iteration.
    [...internalPromoted].forEach((cb) => cb());
    if (!exclusive) [...publicPromoted].forEach((cb) => cb());
  };

  if (coordinating) {
    void locks!
      .request(
        `simplysync:${name}`,
        { mode: "exclusive", signal: leaderAbort.signal },
        async () => {
          if (shuttingDown) return; // granted mid-reload — pass it on
          leader = true;
          // Heal before announcing: the previous leader may have died with
          // writes it never persisted; this tab's in-memory copy has them
          // (they arrived as broadcasts). No-op before the DB is open.
          await persist(name).catch(() => undefined);
          firePromoted();
          // Hold leadership until the page dies (unload releases the lock,
          // promoting the next queued tab) or a shutdown/close releases it.
          await new Promise<void>((resolve) => {
            releaseHeld = resolve;
          });
        },
      )
      .catch(() => undefined); // aborted by shutdown
  }

  channel &&
    (channel.onmessage = (event: { data: unknown }) => {
      const m = event.data as TabMessage;
      switch (m.t) {
        case "events":
          eventListeners.forEach((cb) => cb(m.events));
          break;
        case "sync-state":
          syncStateListeners.forEach((cb) => cb(m.state));
          break;
        case "persist-req":
          // Only the leader answers; during a destructive op nobody does —
          // the requester keeps re-asking until the op's reload finishes and
          // a fresh leader exists.
          if (!leader || exclusive) break;
          void persist(name)
            .catch(() => undefined)
            .then(() => post({ t: "persist-ack", reqId: m.reqId }));
          break;
        case "persist-ack":
          persistWaiters.get(m.reqId)?.();
          break;
        case "shutdown":
          // Two tabs starting destructive ops simultaneously: lower tab id
          // wins, the loser reloads (its op dies with the page — the user
          // sees a reboot, not corruption).
          if (exclusive && m.from > tabId) break;
          shuttingDown = true;
          leader = false;
          releaseHeld?.(); // leader: hand the writer lock to the initiator
          leaderAbort.abort(); // follower: leave the leadership queue
          (options.onShutdown ?? (() => globalThis.location?.reload?.()))();
          break;
      }
    });

  const requestPersist = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const reqId = `${tabId}:${(reqSeq += 1)}`;
      let timer: ReturnType<typeof setInterval> | null = null;
      const finish = (acked: boolean): void => {
        if (timer !== null) clearInterval(timer);
        persistWaiters.delete(reqId);
        internalPromoted.delete(onPromote);
        resolve(acked);
      };
      const onPromote = (): void => finish(false);
      if (leader) return finish(false);
      persistWaiters.set(reqId, () => finish(true));
      internalPromoted.add(onPromote);
      const send = (): void => post({ t: "persist-req", reqId });
      send();
      // Re-ask: the leader may have died between our send and its answer (a
      // promotion, not an ack, resolves us then).
      timer = setInterval(send, 250);
    });

  return {
    isCoordinating: () => coordinating,
    isLeader: () => leader,
    onPromoted(listener) {
      publicPromoted.add(listener);
      return () => publicPromoted.delete(listener);
    },
    publishEvents(events) {
      post({ t: "events", events: [...events] });
    },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    publishSyncState(state) {
      post({ t: "sync-state", state });
    },
    subscribeSyncState(listener) {
      syncStateListeners.add(listener);
      return () => syncStateListeners.delete(listener);
    },
    async withLock(key, fn) {
      if (!locks) return fn();
      // Web Locks resolves request() with the callback's return value.
      const result = await locks.request(
        `simplysync:${name}:${key}`,
        { mode: "exclusive" },
        () => fn(),
      );
      return result as Awaited<ReturnType<typeof fn>>;
    },
    async acquireExclusive() {
      if (!coordinating) return;
      exclusive = true;
      post({ t: "shutdown", from: tabId });
      if (leader) return; // others stop on receipt; we already hold the lock
      // Our queued leadership request is granted once the leader's unload
      // releases the lock.
      await new Promise<void>((resolve) => {
        const once = (): void => {
          internalPromoted.delete(once);
          resolve();
        };
        internalPromoted.add(once);
      });
    },
    async ensureFreshSnapshot() {
      if (!coordinating || leader) return;
      await requestPersist(); // acked or promoted — either way, safe to load
    },
    requestPersist,
    close() {
      shuttingDown = true;
      leader = false;
      releaseHeld?.();
      leaderAbort.abort();
      channel?.close();
    },
  };
}
