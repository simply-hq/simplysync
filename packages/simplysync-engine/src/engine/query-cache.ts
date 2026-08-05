import type { Query, SchemaDefinition } from "../engine-types.js";
import type { EngineState } from "./state.js";

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

  // Structural row-set equality used to decide whether a re-run result is
  // identical to what's cached (see refreshQueries). Deliberately NOT
  // `JSON.stringify` comparison: the schema's column type system allows
  // `"blob"` columns (see SqliteColumnType in type.ts), and drivers that
  // support them (e.g. sql.js, bun:sqlite) surface BLOBs as `Uint8Array`,
  // which `JSON.stringify` does not serialize meaningfully — that would let
  // two different byte buffers compare "equal" and produce a stale read, or
  // vice versa. Compare byte-for-byte for `Uint8Array`/`ArrayBuffer` views and
  // with `Object.is` (stricter than `===`: distinguishes `NaN`/`NaN` as equal
  // and `0`/`-0` as different) for everything else. Err strict: a too-loose
  // compare causes a stale UI (a real bug); a too-strict one only loses the
  // optimization (harmless, just re-renders).
  const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  };

  const cellsEqual = (a: unknown, b: unknown): boolean => {
    if (a instanceof Uint8Array || b instanceof Uint8Array) {
      return a instanceof Uint8Array && b instanceof Uint8Array && bytesEqual(a, b);
    }
    return Object.is(a, b);
  };

  const rowEqual = (
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): boolean => {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const key of aKeys) {
      if (!(key in b) || !cellsEqual(a[key], b[key])) return false;
    }
    return true;
  };

  // Rows come straight from `driver.select`: an array of flat column-value
  // objects, fresh each call. Same length + every row structurally equal (by
  // column key/value) means the query result did not actually change.
  const rowsEqual = (a: readonly unknown[], b: readonly unknown[]): boolean => {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const ra = a[i];
      const rb = b[i];
      if (ra === rb) continue;
      if (
        typeof ra !== "object" ||
        ra === null ||
        typeof rb !== "object" ||
        rb === null
      ) {
        return false;
      }
      if (!rowEqual(ra as Record<string, unknown>, rb as Record<string, unknown>))
        return false;
    }
    return true;
  };

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
      const next = runQuery(entry.sql, entry.params);
      // Keep the stable reference and skip listeners when the re-run result is
      // unchanged — this is the stability contract documented at :14-19.
      if (rowsEqual(entry.rows, next)) continue;
      entry.rows = next;
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
