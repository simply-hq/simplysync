import { describe, expect, test } from "bun:test";
import {
  createTabCoordinator,
  type TabChannel,
  type TabCoordinator,
  type TabLockManager,
} from "../src/tab-coordinator";

const tick = () => new Promise((r) => setTimeout(r, 5));

// A queued-exclusive Web Locks fake: grants in request order, honours signal
// aborts for pending requests, releases when the granted callback settles.
function createFakeLocks(): TabLockManager {
  const queues = new Map<
    string,
    { busy: boolean; waiting: Array<() => void> }
  >();
  const stateOf = (name: string) => {
    let s = queues.get(name);
    if (!s) {
      s = { busy: false, waiting: [] };
      queues.set(name, s);
    }
    return s;
  };
  const pump = (name: string) => {
    const s = stateOf(name);
    if (s.busy) return;
    const next = s.waiting.shift();
    if (next) next();
  };
  return {
    request(name, options, callback) {
      const s = stateOf(name);
      return new Promise((resolve, reject) => {
        let aborted = false;
        options.signal?.addEventListener("abort", () => {
          aborted = true;
          const i = s.waiting.indexOf(grant);
          if (i >= 0) s.waiting.splice(i, 1);
          reject(new Error("aborted"));
        });
        const grant = () => {
          if (aborted) return pump(name);
          s.busy = true;
          void callback({})
            .then(resolve, reject)
            .finally(() => {
              s.busy = false;
              pump(name);
            });
        };
        s.waiting.push(grant);
        pump(name);
      });
    },
  };
}

// A BroadcastChannel fake: async delivery to every OTHER member (matching the
// real API, which never loops a message back to its sender).
function createFakeBus() {
  const channels: FakeChannel[] = [];
  class FakeChannel implements TabChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    closed = false;
    postMessage(data: unknown): void {
      for (const other of channels) {
        if (other === this || other.closed) continue;
        queueMicrotask(() => other.onmessage?.({ data }));
      }
    }
    close(): void {
      this.closed = true;
    }
  }
  return {
    join(): TabChannel {
      const c = new FakeChannel();
      channels.push(c);
      return c;
    },
  };
}

function makeTab(
  locks: TabLockManager,
  bus: ReturnType<typeof createFakeBus>,
  persists: string[],
  label: string,
  onShutdown?: () => void,
): TabCoordinator {
  return createTabCoordinator({
    databaseName: "coord-test",
    locks,
    channel: bus.join(),
    persist: async () => {
      persists.push(label);
    },
    onShutdown: onShutdown ?? (() => undefined),
  });
}

describe("tab coordinator", () => {
  test("first tab leads; a follower's boot barrier resolves after a leader persist", async () => {
    const locks = createFakeLocks();
    const bus = createFakeBus();
    const persists: string[] = [];
    const t1 = makeTab(locks, bus, persists, "t1");
    await tick();
    expect(t1.isLeader()).toBe(true);

    const t2 = makeTab(locks, bus, persists, "t2");
    await tick();
    expect(t2.isLeader()).toBe(false);

    await t2.ensureFreshSnapshot();
    // The leader persisted on t2's request (plus its own promotion heal).
    expect(persists.filter((p) => p === "t1").length).toBeGreaterThanOrEqual(2);

    // Follower persistNow forwarding.
    expect(await t2.requestPersist()).toBe(true);
    t1.close();
    t2.close();
  });

  test("leader death promotes the next tab, which heals with a persist", async () => {
    const locks = createFakeLocks();
    const bus = createFakeBus();
    const persists: string[] = [];
    const t1 = makeTab(locks, bus, persists, "t1");
    const t2 = makeTab(locks, bus, persists, "t2");
    await tick();

    let promoted = false;
    t2.onPromoted(() => {
      promoted = true;
    });
    t1.close(); // tab death: the browser releases the lock
    await tick();
    expect(t2.isLeader()).toBe(true);
    expect(promoted).toBe(true);
    expect(persists).toContain("t2");
    t2.close();
  });

  test("acquireExclusive stops the leader and hands the initiator sole writership", async () => {
    const locks = createFakeLocks();
    const bus = createFakeBus();
    const persists: string[] = [];
    let leaderShutdown = 0;
    const t1 = makeTab(locks, bus, persists, "t1", () => {
      leaderShutdown += 1;
      t1.close(); // the real handler reloads the page, which releases the lock
    });
    const t2 = makeTab(locks, bus, persists, "t2");
    await tick();
    expect(t1.isLeader()).toBe(true);

    await t2.acquireExclusive();
    expect(leaderShutdown).toBe(1);
    expect(t2.isLeader()).toBe(true);
    // While exclusive, public promotion listeners must NOT have fired (the
    // initiator is about to replace the database, not start syncing).
    let publicFired = false;
    t2.onPromoted(() => {
      publicFired = true;
    });
    expect(publicFired).toBe(false);
    t2.close();
  });

  test("events and sync state fan out to other tabs only", async () => {
    const locks = createFakeLocks();
    const bus = createFakeBus();
    const persists: string[] = [];
    const t1 = makeTab(locks, bus, persists, "t1");
    const t2 = makeTab(locks, bus, persists, "t2");
    await tick();

    const seen: string[] = [];
    t1.subscribeEvents((events) => seen.push(`t1:${events.length}`));
    t2.subscribeEvents((events) => seen.push(`t2:${events.length}`));
    t1.publishEvents([{ eventId: "e1", payloadJson: "{}", outbox: true }]);
    await tick();
    expect(seen).toEqual(["t2:1"]);

    const states: string[] = [];
    t2.subscribeSyncState((s) => states.push(s.type));
    t1.publishSyncState({ type: "SyncStateInitial" });
    await tick();
    expect(states).toEqual(["SyncStateInitial"]);
    t1.close();
    t2.close();
  });

  test("withLock serializes cross-tab critical sections", async () => {
    const locks = createFakeLocks();
    const bus = createFakeBus();
    const t1 = makeTab(locks, bus, [], "t1");
    const t2 = makeTab(locks, bus, [], "t2");
    await tick();

    const order: string[] = [];
    const slow = t1.withLock("identity", async () => {
      order.push("t1-start");
      await tick();
      order.push("t1-end");
      return "a";
    });
    const fast = t2.withLock("identity", async () => {
      order.push("t2");
      return "b";
    });
    expect(await Promise.all([slow, fast])).toEqual(["a", "b"]);
    expect(order).toEqual(["t1-start", "t1-end", "t2"]);
    t1.close();
    t2.close();
  });

  test("without Web Locks or BroadcastChannel the coordinator is inert (sole leader)", () => {
    const inert = createTabCoordinator({
      databaseName: "coord-test",
      locks: null,
      channel: null,
    });
    expect(inert.isCoordinating()).toBe(false);
    expect(inert.isLeader()).toBe(true);
    inert.close();
  });
});
