import type { Query, SchemaDefinition } from "../engine-types";
import type { EngineState } from "./state";

interface QueryEntry {
  sql: string;
  params: readonly unknown[];
  tables: Set<string>;
  rows: readonly unknown[];
  listeners: Set<() => void>;
}

export type QueryCache = ReturnType<typeof createQueryCache>;

/**
 * The reactive query cache. Each compiled query is cached by `sql::params` with
 * a STABLE `rows` array reference (React's `useSyncExternalStore` relies on the
 * reference only changing when the data does). A mutation/sync calls
 * `refreshQueries(changedTables)`, which re-runs and swaps `rows` only for the
 * queries whose tables overlap, then fires their listeners.
 */
export function createQueryCache(state: EngineState, schema: SchemaDefinition) {
  // queryKey -> entry. Owned here; nothing outside this module touches it.
  const queries = new Map<string, QueryEntry>();
  let reportedQueryError = false;

  const tablesInSql = (sql: string): Set<string> => {
    const found = new Set<string>();
    for (const table of Object.keys(schema)) {
      if (sql.includes(`"${table}"`)) found.add(table);
    }
    return found;
  };

  const queryKey = (query: Query): string =>
    `${query.sql}::${JSON.stringify(query.parameters)}`;

  const runQuery = (sql: string, params: readonly unknown[]): unknown[] => {
    const { driver } = state;
    if (!driver) return [];
    try {
      return driver.select(sql, params);
    } catch (caught) {
      // Before the schema exists, tables may be missing — treat as empty.
      // After init, a failure here is a real DB error (corruption, disk full,
      // bad SQL): surface it instead of masquerading as "no data" (which would
      // render a permanently blank screen with no signal).
      if (state.schemaReady) {
        console.error("local-first query failed:", sql, caught);
        if (!reportedQueryError) {
          reportedQueryError = true;
          state.setError({
            type: "QueryError",
            message: caught instanceof Error ? caught.message : String(caught),
          });
        }
      }
      return [];
    }
  };

  // Get the cached entry for a query, creating (and hydrating) it on first use.
  // Shared by getRows and subscribeQuery so both see the same stable rows array.
  const getOrCreateEntry = (query: Query) => {
    const key = queryKey(query);
    let entry = queries.get(key);
    if (!entry) {
      entry = {
        sql: query.sql,
        params: query.parameters,
        tables: tablesInSql(query.sql),
        rows: state.driver ? runQuery(query.sql, query.parameters) : [],
        listeners: new Set(),
      };
      queries.set(key, entry);
    }
    return { key, entry };
  };

  const refreshQueries = (changedTables: Iterable<string>) => {
    const changed = new Set(changedTables);
    for (const entry of queries.values()) {
      let touched = false;
      for (const table of entry.tables) {
        if (changed.has(table)) {
          touched = true;
          break;
        }
      }
      if (!touched) continue;
      entry.rows = runQuery(entry.sql, entry.params);
      entry.listeners.forEach((l) => l());
    }
  };

  // Stable per-query array reference (cached) so React's useSyncExternalStore
  // doesn't loop; refreshQueries swaps it on change.
  const getRows = (query: Query): readonly unknown[] =>
    getOrCreateEntry(query).entry.rows;

  // Eager (awaited) read: re-run now and refresh the cache entry if present.
  const loadRows = (query: Query): readonly unknown[] => {
    const rows = runQuery(query.sql, query.parameters);
    const entry = queries.get(queryKey(query));
    if (entry) entry.rows = rows;
    return rows;
  };

  const subscribeQuery = (query: Query) => {
    const { key, entry } = getOrCreateEntry(query);
    return (listener: () => void) => {
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) queries.delete(key);
      };
    };
  };

  return { refreshQueries, getRows, loadRows, subscribeQuery };
}
