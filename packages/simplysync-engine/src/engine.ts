import {
  SYNC_SCHEMA_VERSION,
} from "@simplysync/protocol";
import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import type {
  Database,
  Query,
  SchemaDefinition,
  SyncEngine,
  SyncEngineConfig,
  SyncEngineDeps,
} from "./engine-types.js";
import { createEngineState } from "./engine/state.js";
import { TOMBSTONE_RETENTION_MS } from "./engine/constants.js";
import { createStore, createClock } from "./engine/store.js";
import { createQueryCache } from "./engine/query-cache.js";
import { createRelaySync } from "./engine/relay.js";
import { createTabBridge } from "./engine/tab-sync.js";
import {
  createLifecycle,
  createMutations,
} from "./engine/mutations-lifecycle.js";

// This file is the public entry point: the `createSync` factory wires the
// engine's concerns together and assembles the `SyncEngine` instance. The
// concerns themselves live in ./engine/*:
//   state.ts             — the shared mutable EngineState + notifiers
//   store.ts             — local SQLite (schema/meta/rows) + the HLC clock
//   query-cache.ts       — the reactive, stable-reference query cache
//   relay.ts             — push/pull/poll sync against a relay
//   mutations-lifecycle  — the write path + boot/owner management
export { createIdFromString } from "./engine/ids.js";

/** Builds a compile-only Kysely instance (SQLite dialect, no real driver). */
function createCompiler<S extends SchemaDefinition>(): Kysely<Database<S>> {
  return new Kysely<Database<S>>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
}

// Deletes are tombstones that must replicate (see engine/mutations-lifecycle),
// so soft-deleted rows stay in their table and a SELECT that forgets
// `isDeleted` silently returns them. It is the most common way to misuse this
// API and it fails quietly — a deleted row reappears in the UI rather than
// throwing — so say so at query-build time. Deduped by SQL text because
// createQuery is often called per render. Opt out with `{ includeDeleted: true }`
// for queries that intentionally read tombstones.
//
// This is deliberately advisory rather than a SQL parser. It catches the
// dominant case (no tombstone predicate at all); in a join, filtering one table
// can still silence the check for another.
const warnedTombstoneQueries = new Set<string>();

function warnMissingTombstoneFilter(
  sql: string,
  schema: SchemaDefinition,
): void {
  if (!/^\s*select/i.test(sql)) return;
  // Seeing isDeleted in the projection is not enough: the row is still
  // returned. Only a predicate acknowledges tombstones.
  const predicateStart = sql.search(/\b(?:where|having)\b/i);
  if (
    predicateStart >= 0 &&
    sql.slice(predicateStart).includes('"isDeleted"')
  ) {
    return;
  }
  const tables = Object.keys(schema).filter((table) =>
    sql.includes(`"${table}"`),
  );
  if (tables.length === 0 || warnedTombstoneQueries.has(sql)) return;
  warnedTombstoneQueries.add(sql);
  console.warn(
    `SimplySync: this query reads ${tables.join(", ")} without an isDeleted ` +
      `filter, so soft-deleted rows are included. Add ` +
      `.where("isDeleted", "=", 0), or pass { includeDeleted: true } to ` +
      `createQuery if that is intended.\n  ${sql}`,
  );
}

export const createSync =
  (deps: SyncEngineDeps) =>
  <S extends SchemaDefinition>(
    schema: S,
    config: SyncEngineConfig,
  ): SyncEngine<S> => {
    const schemaVersion = config.schemaVersion ?? SYNC_SCHEMA_VERSION;
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
      throw new Error(
        "SimplySync schemaVersion must be a positive safe integer.",
      );
    }
    const compiler = createCompiler<S>();
    const fetchImpl = deps.fetch ?? globalThis.fetch;

    // Assemble the concerns in dependency order: each closes over the shared
    // `state`; later groups receive earlier ones as plain parameters (no group
    // references a not-yet-built sibling, and none reference `instance`).
    const state = createEngineState(config);
    const store = createStore(state, schema, config, schemaVersion);
    const clock = createClock(state, store);
    const queryCache = createQueryCache(state, schema);
    const bridge = createTabBridge(
      state,
      store,
      clock,
      queryCache,
      schema,
      deps.tabSync,
      schemaVersion,
    );
    const relay = createRelaySync(
      state,
      store,
      clock,
      queryCache,
      bridge,
      schema,
      deps,
      config,
      fetchImpl,
      schemaVersion,
    );
    const mutations = createMutations(
      state,
      store,
      clock,
      queryCache,
      relay,
      bridge,
      schema,
      schemaVersion,
    );
    const lifecycle = createLifecycle(
      state,
      store,
      queryCache,
      relay,
      mutations,
      bridge,
      schema,
      deps,
      config,
      fetchImpl,
    );

    // Only the leader talks to relays; mirror its sync state to followers so
    // sync UI (useSyncState) is truthful in every tab.
    const tabSync = deps.tabSync;
    if (tabSync) {
      const emit = state.setSyncState;
      state.setSyncState = (next) => {
        emit(next);
        if (tabSync.isLeader()) tabSync.publishSyncState(next);
      };
      tabSync.subscribeSyncState((next) => {
        if (!tabSync.isLeader()) emit(next);
      });
    }

    // engine.ready: kick off init exactly once; every awaiting method uses this
    // single promise (loadQuery, importLegacy, the appOwner getter).
    const ready = lifecycle.init();

    const instance: SyncEngine<S> = {
      createQuery(fn, options) {
        const compiled = fn(compiler).compile();
        if (!options?.includeDeleted) {
          warnMissingTombstoneFilter(compiled.sql, schema);
        }
        return {
          sql: compiled.sql,
          parameters: compiled.parameters as readonly unknown[],
          Row: undefined as never,
        };
      },
      getQueryRows<R>(query: Query<R>) {
        return queryCache.getRows(query) as readonly R[];
      },
      async loadQuery<R>(query: Query<R>) {
        await ready;
        return queryCache.loadRows(query) as readonly R[];
      },
      subscribeQuery(query) {
        return queryCache.subscribeQuery(query);
      },
      insert(table, values, options) {
        return mutations.mutate(
          table,
          values as Record<string, unknown>,
          "insert",
          options,
        );
      },
      update(table, values, options) {
        return mutations.mutate(
          table,
          values as Record<string, unknown>,
          "update",
          options,
        );
      },
      upsert(table, values, options) {
        return mutations.mutate(
          table,
          values as Record<string, unknown>,
          "upsert",
          options,
        );
      },
      batch(ops, options) {
        return mutations.batch(
          ops as ReadonlyArray<{
            table: string;
            values: Record<string, unknown>;
            mode?: "insert" | "update" | "upsert" | "delete";
            expectedUpdatedAt?: string;
          }>,
          options,
        );
      },
      restore(table, id, expectedUpdatedAt, options) {
        return mutations.mutate(
          table,
          { id },
          "restore",
          { ...options, expectedUpdatedAt, expectedDeleted: true },
        );
      },
      delete(table, id, options) {
        return mutations.mutate(table, { id }, "delete", options);
      },
      deleteMany(table, ids, options) {
        return mutations.batch(
          ids.map((id) => ({ table, values: { id }, mode: "delete" as const })),
          options,
        );
      },
      useOwner(options) {
        if (options.transports) instance.setTransports(options.transports);
        return () => instance.setTransports([]);
      },
      async importLegacy(legacyDbName) {
        await ready;
        return lifecycle.importLegacy(legacyDbName);
      },
      get appOwner() {
        // STABLE promise reference (React `use()`); reset only on owner switch.
        state.appOwnerPromise ??= ready.then(() => state.appOwnerValue);
        return state.appOwnerPromise;
      },
      restoreAppOwner(recoveryKey, options) {
        return lifecycle.restoreAppOwner(
          recoveryKey,
          options,
          instance.reloadApp,
        );
      },
      resetAppOwner(options?: { force?: boolean }) {
        return lifecycle.resetAppOwner(options, instance.reloadApp);
      },
      async exportDatabase(options) {
        await ready;
        return lifecycle.exportDatabase(options);
      },
      async importDatabase(envelope, options) {
        await ready;
        return lifecycle.importDatabase(envelope, options, instance.reloadApp);
      },
      subscribeError(listener) {
        state.errorListeners.add(listener);
        return () => state.errorListeners.delete(listener);
      },
      getError() {
        return state.error;
      },
      subscribeSyncState(listener) {
        state.syncListeners.add(listener);
        return () => state.syncListeners.delete(listener);
      },
      getSyncState() {
        return state.syncState;
      },
      getSyncLog(limit) {
        return store.recentSyncLog(limit);
      },
      getPendingOutboxCount() {
        return store.pendingOutboxCount();
      },
      async getRelayStatuses() {
        await ready;
        return relay.getRelayStatuses();
      },
      purgeDeleted(options) {
        // Retain synced tombstones until the protocol has a durable,
        // cross-device delete watermark. Hard-deleting/compacting them today
        // lets a long-offline device resurrect stale data. Durable relay
        // history keeps this guard active after transports are detached.
        if (state.transports.length > 0 || store.hasRelayHistory()) {
          return { purged: 0 };
        }
        const olderThanMs = options?.olderThanMs ?? TOMBSTONE_RETENTION_MS;
        const purged = store.purgeDeleted(olderThanMs, Date.now());
        // Nudge the relay-side stream compaction along without waiting for the
        // next poll; failures are retried by the sync loop's drain.
        if (purged > 0) void relay.sync();
        return { purged };
      },
      purgeRows(rows) {
        if (state.transports.length > 0 || store.hasRelayHistory()) {
          return { purged: 0 };
        }
        const purged = store.purgeRows(rows);
        if (purged > 0) void relay.sync();
        return { purged };
      },
      setTransports(next) {
        relay.setTransports(next);
      },
      sync: relay.sync,
      reloadApp() {
        if (deps.reloadApp) {
          void deps.reloadApp();
          return;
        }
        globalThis.location?.reload?.();
      },
      ready,
    };

    return instance;
  };
