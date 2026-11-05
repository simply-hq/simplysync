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
  RelayStatus,
  SyncEngine,
  SyncError,
  Query,
  SyncState,
  AppOwner,
  Transport,
} from "@simplysync/engine";

// The React bindings the apps use:
// SyncProvider, useSync, useQuery (reactive), useSyncState, useSyncError.

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

type RowsOf<Q> = {
  readonly [K in keyof Q]: Q[K] extends Query<infer R> ? readonly R[] : never;
};

/**
 * Several reactive queries in one hook, rows returned in the same order. The
 * result array keeps its identity until one query's rows actually change, so
 * it is safe to depend on in effects and memos.
 */
export function useQueries<const Q extends readonly Query[]>(queries: Q): RowsOf<Q> {
  const engine = useSync();
  const key = queries.map(queryDeps).join("|");

  const subscribe = useMemo(
    () => (listener: () => void) => {
      const unsubscribes = queries.map((query) => engine.subscribeQuery(query)(listener));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, key],
  );
  const getSnapshot = useMemo(() => {
    let last: readonly (readonly unknown[])[] | null = null;
    return () => {
      const next = queries.map((query) => engine.getQueryRows(query));
      if (last && last.every((rows, i) => rows === next[i])) return last;
      last = next;
      return last;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, key]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as RowsOf<Q>;
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
