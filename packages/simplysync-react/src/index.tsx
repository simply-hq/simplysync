import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  SyncEngine,
  SyncError,
  Query,
  SchemaDefinition,
  SyncState,
} from "@simplysync/engine";

// Re-export the common types so call sites can import them from the React entry.
export type {
  SyncEngine,
  SyncError,
  Query,
  SyncState,
  AppOwner,
  Transport,
} from "@simplysync/engine";

// The React bindings the apps use:
// SyncProvider, useQuery (reactive), useSyncState, createUseSync/useSync,
// useSyncError.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SyncContext = createContext<SyncEngine<any> | null>(null);

export interface SyncProviderProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly value: SyncEngine<any>;
  readonly children: ReactNode;
}

export function SyncProvider({
  value,
  children,
}: SyncProviderProps): ReactNode {
  return createElement(SyncContext.Provider, { value }, children);
}

export function useSync<S extends SchemaDefinition>(): SyncEngine<S> {
  const engine = useContext(SyncContext);
  if (!engine) {
    throw new Error("useSync must be used within a SyncProvider.");
  }
  return engine as SyncEngine<S>;
}

const queryDeps = (query: Query): string =>
  `${query.sql}::${JSON.stringify(query.parameters)}`;

/** Reactive query hook — re-renders when rows for the query change. */
export function useQuery<R>(query: Query<R>): readonly R[] {
  const engine = useSync();
  const key = queryDeps(query);

  const subscribe = useMemo(
    () => engine.subscribeQuery(query),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, key],
  );
  const getSnapshot = useMemo(
    () => () => engine.getQueryRows(query),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, key],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSyncState(): SyncState {
  const engine = useSync();
  return useSyncExternalStore(
    (listener) => engine.subscribeSyncState(listener),
    () => engine.getSyncState(),
    () => engine.getSyncState(),
  );
}

export function useSyncError(): SyncError | null {
  const engine = useSync();
  return useSyncExternalStore(
    (listener) => engine.subscribeError(listener),
    () => engine.getError(),
    () => engine.getError(),
  );
}

/**
 * `createUseSync(engine)` → a hook returning the mutation API
 * (and owner helpers). Call sites use `const { insert, update, upsert } = useSync()`.
 */
export function createUseSync<S extends SchemaDefinition>(engine: SyncEngine<S>) {
  return function useSyncMutations() {
    return useMemo(
      () => ({
        insert: engine.insert.bind(engine),
        update: engine.update.bind(engine),
        upsert: engine.upsert.bind(engine),
        restoreAppOwner: engine.restoreAppOwner.bind(engine),
        resetAppOwner: engine.resetAppOwner.bind(engine),
      }),
      [],
    );
  };
}
