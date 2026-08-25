// One set of adapters for the seams the engine already declares: the SQLite
// driver, secure storage, a Relay, and the cross-tab bus.
//
// Every test file used to grow its own — 23 copies of the driver, 23 of the
// storage, three Relays that had quietly drifted apart. Drift is the cost that
// actually bit: only one of the three Relays could hold a push, and none of
// the tab buses could hold the exclusive lock, so the destructive-op barrier —
// the hardest part of Leader-ship — was never exercised by anything.
//
// These are adapters, not helpers: each implements an interface the engine
// declares, and nothing here reaches past that interface. A test that needs an
// engine module directly (the Store, the admission ladder) still imports it
// directly; what this module exists to stop is reassembling the engine by hand.

import { Database } from "bun:sqlite";
import type { SyncEnvelope } from "@simplysync/protocol";

import type {
  SecureStorage,
  SqliteDriver,
  SyncState,
  TabSync,
  TabSyncEvent,
} from "../../src/index";

// ---------------------------------------------------------------------------
// SqliteDriver
// ---------------------------------------------------------------------------

export interface MemoryDriver {
  readonly driver: SqliteDriver;
  readonly db: Database;
  /**
   * Transactions opened through this driver. The pull path's promise is that a
   * whole page of events lands in ONE transaction, and the only way to tell
   * that apart from an unchanged outward result is to count.
   */
  readonly transactionCalls: () => number;
}

/**
 * An in-memory SQLite driver. Pass a `db` to give two engines (or two "app
 * versions") one physical database, which is how the cross-tab and migration
 * tests share state.
 */
export function memoryDriver(db: Database = new Database(":memory:")): MemoryDriver {
  let calls = 0;
  return {
    db,
    transactionCalls: () => calls,
    driver: {
      exec(sql, params) {
        db.prepare(sql).run(...((params ?? []) as never[]));
      },
      select(sql, params) {
        return db.prepare(sql).all(...((params ?? []) as never[])) as never;
      },
      transaction(fn) {
        calls += 1;
        return db.transaction(fn)();
      },
    },
  };
}

// ---------------------------------------------------------------------------
// SecureStorage
// ---------------------------------------------------------------------------

/**
 * Secure storage backed by a Map. `initial` seeds a stored credential, which is
 * how a test stands up a device that already knows its Owner.
 */
export function memoryStorage(
  initial: Record<string, string> = {},
): SecureStorage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

/**
 * Wait until no sync is in flight, by polling the engine's own sync state
 * rather than guessing a duration. A fixed sleep is a coin flip on a loaded
 * machine and silently over-waits on a fast one; this settles as soon as the
 * pass is done and fails loudly if one never finishes.
 */
export async function settle(engine: {
  getSyncState(): SyncState;
}): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (engine.getSyncState().type !== "SyncStateIsSyncing") return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("sync never settled");
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

export interface FakeRelayOptions {
  /**
   * Serve the whole log on every pull behind a cursor that never moves — a
   * Relay resending an overlapping window. Without it the log behaves like a
   * real Relay: `after` is an offset and a second pull returns what is new.
   */
  readonly resend?: boolean;
  /**
   * Hold the FIRST push open until `release()`, so a second sync provably
   * lands while a pass is in flight.
   */
  readonly holdFirstPush?: boolean;
}

export interface FakeRelay {
  /** The `fetch` implementation to hand the engine. */
  readonly fetch: typeof fetch;
  /**
   * The Relay's event log. Readable (what this device pushed) and writable
   * (synthetic envelopes, as if some other Device had pushed them).
   */
  readonly events: SyncEnvelope[];
  /** Push round-trips received — one per relay contact, not per event. */
  readonly pushCount: () => number;
  /** Event ids the Relay accepted, in arrival order. */
  readonly pushedEventIds: () => readonly string[];
  /** Resolves once the held first push has arrived (`holdFirstPush`). */
  readonly firstPushStarted: Promise<void>;
  /** Let the held first push complete (`holdFirstPush`). */
  readonly release: () => void;
}

/**
 * An in-memory stand-in for a Relay's `/v1/events` push+pull interface — just
 * enough to drive the client's cursor bookkeeping without a Relay process.
 * Ciphertext in, ciphertext out: it never looks inside an envelope, exactly
 * like the real thing.
 */
export function fakeRelay(options: FakeRelayOptions = {}): FakeRelay {
  const events: SyncEnvelope[] = [];
  const pushedEventIds: string[] = [];
  let pushes = 0;
  let markFirstPush!: () => void;
  const firstPushStarted = new Promise<void>((resolve) => {
    markFirstPush = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.pathname !== "/v1/events") {
      return new Response("not found", { status: 404 });
    }
    if (init?.method === "POST") {
      pushes += 1;
      const body = JSON.parse(String(init.body)) as { events: SyncEnvelope[] };
      events.push(...body.events);
      for (const e of body.events) pushedEventIds.push(e.eventId);
      if (pushes === 1) {
        markFirstPush();
        if (options.holdFirstPush) await released;
      }
      return new Response(
        JSON.stringify({ accepted: body.events.length, duplicate: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const after = options.resend
      ? 0
      : Number(url.searchParams.get("after") ?? "0") || 0;
    const slice = events.slice(after);
    // In resend mode the cursor is the log head every time, so the client sees
    // it stop moving and ends its drain instead of spinning on the same page.
    const nextCursor = String(after + slice.length);
    return new Response(JSON.stringify({ events: slice, nextCursor }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    events,
    pushCount: () => pushes,
    pushedEventIds: () => pushedEventIds,
    firstPushStarted,
    release,
  };
}

// ---------------------------------------------------------------------------
// TabSync
// ---------------------------------------------------------------------------

export interface FakeTabBus {
  /** Add a member. Exactly one member should start as the Leader. */
  join(leader: boolean): TabSync;
  /** Make `member` the Leader and fire its promotion listeners. */
  promote(member: TabSync): void;
  /**
   * Take the shared lock as if another tab held it; resolves to its release.
   * A destructive op's barrier queues behind this, which is what makes
   * "the op waited" observable.
   */
  hold(): Promise<() => void>;
}

/**
 * An in-process TabSync bus: N members, synchronous delivery to everyone else,
 * manually driven leadership. Mirrors what the browser coordinator does with
 * BroadcastChannel + Web Locks.
 *
 * `withLock` and `acquireExclusive` share ONE lock, because the browser
 * coordinator backs both with one Web Lock name. A fake that resolved
 * `acquireExclusive` immediately would let every destructive-op test pass
 * whether or not the barrier existed.
 */
export function fakeTabBus(): FakeTabBus {
  interface Member extends TabSync {
    readonly _events: Set<(events: readonly TabSyncEvent[]) => void>;
    readonly _syncStates: Set<(state: SyncState) => void>;
    readonly _promoted: Set<() => void>;
    _leader: boolean;
  }
  const members: Member[] = [];

  // Serial lock. Each waiter runs only after the previous one's turn ends, so
  // a holder that never releases blocks the rest — the browser's Web Lock, and
  // the reason the barrier is worth having.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const hold = (): Promise<() => void> =>
    new Promise((granted) => {
      void enqueue(() => new Promise<void>((release) => granted(release)));
    });

  const join = (leader: boolean): TabSync => {
    const member: Member = {
      _events: new Set(),
      _syncStates: new Set(),
      _promoted: new Set(),
      _leader: leader,
      isLeader: () => member._leader,
      onPromoted(cb) {
        member._promoted.add(cb);
        return () => member._promoted.delete(cb);
      },
      publishEvents(events) {
        for (const other of members) {
          if (other === member) continue;
          other._events.forEach((cb) => cb(events));
        }
      },
      subscribeEvents(cb) {
        member._events.add(cb);
        return () => member._events.delete(cb);
      },
      publishSyncState(state) {
        for (const other of members) {
          if (other === member) continue;
          other._syncStates.forEach((cb) => cb(state));
        }
      },
      subscribeSyncState(cb) {
        member._syncStates.add(cb);
        return () => member._syncStates.delete(cb);
      },
      withLock(_key, fn) {
        return enqueue(fn);
      },
      // The tab that wins the barrier keeps it until it reloads, so the fake
      // never releases either: a test that needs the lock back takes it with
      // `hold()` beforehand and releases that instead.
      acquireExclusive: () => hold().then(() => undefined),
    };
    members.push(member);
    return member;
  };

  const promote = (member: TabSync): void => {
    for (const m of members) m._leader = m === member;
    (member as Member)._promoted.forEach((cb) => cb());
  };

  return { join, promote, hold };
}
