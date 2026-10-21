import type { LocalFirstIdentity } from "@simplysync/protocol";
import type {
  AppOwner,
  SqliteDriver,
  SyncEngineConfig,
  SyncError,
  SyncState,
  Transport,
} from "../engine-types.js";

/**
 * The mutable state shared across the engine's concern modules (store, query
 * cache, relay sync, mutations, lifecycle). Each module closes over a single
 * `EngineState` instance rather than re-deriving the same `let` bindings — this
 * is what lets the logic live in separate files while still sharing one driver,
 * identity, transport list, and clock high-water mark.
 *
 * Single-owner mutable state stays local to its module instead of living here:
 * the query cache owns its `queries` Map, the relay owns its poll timer.
 */
export interface EngineState {
  driver: SqliteDriver | null;
  identity: LocalFirstIdentity | null;
  deviceId: string;

  appOwnerValue: AppOwner | null;
  /**
   * Cached so `engine.appOwner` returns a STABLE promise reference — required by
   * React's `use(engine.appOwner)` (a fresh promise each access makes `use`
   * suspend forever). Reset when the owner changes (restore/reset).
   */
  appOwnerPromise: Promise<AppOwner | null> | null;

  // HLC clock high-water mark (seeded from _sync_meta on boot; see createClock).
  hlcTime: number;
  hlcCounter: number;

  transports: Transport[];
  syncing: boolean;
  schemaReady: boolean;

  error: SyncError | null;
  syncState: SyncState;
  readonly errorListeners: Set<() => void>;
  readonly syncListeners: Set<() => void>;
  setError(next: SyncError | null): void;
  setSyncState(next: SyncState): void;
}

/**
 * Call every listener even if one throws. Listeners are app code running in
 * the middle of a write or sync pass; letting one throw would surface a
 * committed write as a failure, or abort the pass before it records its
 * outcome. The error is reported, never swallowed silently.
 */
export function notifyAll(listeners: Iterable<() => void>): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (caught) {
      console.error("SimplySync: a subscriber threw", caught);
    }
  }
}

export function createEngineState(config: SyncEngineConfig): EngineState {
  const errorListeners = new Set<() => void>();
  const syncListeners = new Set<() => void>();

  // Object-literal methods that close over `state` keep `this` out of it.
  const state: EngineState = {
    driver: null,
    identity: null,
    deviceId: "",
    appOwnerValue: null,
    appOwnerPromise: null,
    hlcTime: 0,
    hlcCounter: 0,
    transports: [...(config.transports ?? [])],
    syncing: false,
    schemaReady: false,
    error: null,
    syncState: { type: "SyncStateInitial" },
    errorListeners,
    syncListeners,
    setError(next) {
      state.error = next;
      notifyAll(errorListeners);
    },
    setSyncState(next) {
      state.syncState = next;
      notifyAll(syncListeners);
    },
  };
  return state;
}
