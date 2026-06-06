import type { LocalFirstIdentity } from "@simplysync/protocol";
import type {
  AppOwner,
  SqliteDriver,
  SyncEngineConfig,
  SyncError,
  SyncState,
  Transport,
} from "../engine-types";

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
      errorListeners.forEach((l) => l());
    },
    setSyncState(next) {
      state.syncState = next;
      syncListeners.forEach((l) => l());
    },
  };
  return state;
}
