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
} from "./engine-types";
import { createEngineState } from "./engine/state";
import { TOMBSTONE_RETENTION_MS } from "./engine/constants";
import { createStore, createClock } from "./engine/store";
import { createQueryCache } from "./engine/query-cache";
import { createRelaySync } from "./engine/relay";
import {
  createLifecycle,
  createMutations,
} from "./engine/mutations-lifecycle";

// This file is the public entry point: the `createSync` factory wires the
// engine's concerns together and assembles the `SyncEngine` instance. The
// concerns themselves live in ./engine/*:
//   state.ts             — the shared mutable EngineState + notifiers
//   store.ts             — local SQLite (schema/meta/rows) + the HLC clock
//   query-cache.ts       — the reactive, stable-reference query cache
//   relay.ts             — push/pull/poll sync against a relay
//   mutations-lifecycle  — the write path + boot/owner management
export { createIdFromString } from "./engine/ids";

// Default tombstone grace period for `purgeDeleted`: long enough that a delete
// has reached the relay and any active peer before its row is reclaimed.
// Shared with the sync loop's automatic sweep (see engine/constants.ts).
const THIRTY_DAYS_MS = TOMBSTONE_RETENTION_MS;

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

export const createSync =
  (deps: SyncEngineDeps) =>
  <S extends SchemaDefinition>(
    schema: S,
    config: SyncEngineConfig,
  ): SyncEngine<S> => {
    const compiler = createCompiler<S>();
    const fetchImpl = deps.fetch ?? globalThis.fetch;

    // Assemble the concerns in dependency order: each closes over the shared
    // `state`; later groups receive earlier ones as plain parameters (no group
    // references a not-yet-built sibling, and none reference `instance`).
    const state = createEngineState(config);
    const store = createStore(state, schema, config);
    const clock = createClock(state, store);
    const queryCache = createQueryCache(state, schema);
    const relay = createRelaySync(
      state,
      store,
      clock,
      queryCache,
      schema,
      deps,
      config,
      fetchImpl,
    );
    const mutations = createMutations(
      state,
      store,
      clock,
      queryCache,
      relay,
      schema,
    );
    const lifecycle = createLifecycle(
      state,
      store,
      queryCache,
      relay,
      mutations,
      schema,
      deps,
      config,
      fetchImpl,
    );

    // engine.ready: kick off init exactly once; every awaiting method uses this
    // single promise (loadQuery, importLegacy, the appOwner getter).
    const ready = lifecycle.init();

    const instance: SyncEngine<S> = {
      createQuery(fn) {
        const compiled = fn(compiler).compile();
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
          }>,
          options,
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
      restoreAppOwner(mnemonic, options) {
        return lifecycle.restoreAppOwner(mnemonic, options, instance.reloadApp);
      },
      resetAppOwner() {
        return lifecycle.resetAppOwner(instance.reloadApp);
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
        // lets a long-offline device resurrect stale data.
        if (state.transports.length > 0) return { purged: 0 };
        const olderThanMs = options?.olderThanMs ?? THIRTY_DAYS_MS;
        const purged = store.purgeDeleted(olderThanMs, Date.now());
        // Nudge the relay-side stream compaction along without waiting for the
        // next poll; failures are retried by the sync loop's drain.
        if (purged > 0) void relay.sync();
        return { purged };
      },
      purgeRows(rows) {
        if (state.transports.length > 0) return { purged: 0 };
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
