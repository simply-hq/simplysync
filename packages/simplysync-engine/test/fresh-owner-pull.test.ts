import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createSync,
  id,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
} from "../src/index";

function makeDriver(db = new Database(":memory:")): SqliteDriver {
  return {
    exec(sql, params) {
      db.prepare(sql).run(...((params ?? []) as never[]));
    },
    select(sql, params) {
      return db.prepare(sql).all(...((params ?? []) as never[])) as never;
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
  };
}

function memoryStorage(): SecureStorage {
  const map = new Map<string, string>();
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

const schema = { note: { id: id("Note"), body: NonEmptyString } };

/**
 * Both reference relays create an owner on PUSH only, so a device that boots
 * before it (or a peer) has ever pushed gets 404 "Unknown owner" from pull. That
 * is an empty account, not a broken one — treating it as a terminal failure made
 * every fresh install show a hard sync error and stall its poller for 5 minutes.
 */
describe("a never-synced owner pulls empty, not terminal", () => {
  test("404 on pull leaves the engine synced rather than terminally failed", async () => {
    let pulls = 0;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ accepted: 0, duplicate: 0 }), {
          status: 200,
        });
      }
      pulls += 1;
      return new Response(JSON.stringify({ error: "Unknown owner" }), {
        status: 404,
      });
    }) as typeof fetch;

    const engine = createSync({
      createSqliteDriver: () => makeDriver(),
      secureStorage: memoryStorage(),
      fetch: fetchImpl,
    })(schema, {
      name: "fresh-owner-test",
      transports: [{ type: "Http", url: "http://relay.test" }],
    });
    await engine.ready;

    await engine.sync();

    expect(pulls).toBeGreaterThan(0);
    const state = engine.getSyncState();
    expect(state.type).toBe("SyncStateIsSynced");
    engine.setTransports([]);
  });

  test("a real pull failure is still reported", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ accepted: 0, duplicate: 0 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      });
    }) as typeof fetch;

    const engine = createSync({
      createSqliteDriver: () => makeDriver(),
      secureStorage: memoryStorage(),
      fetch: fetchImpl,
    })(schema, {
      name: "fresh-owner-fail-test",
      transports: [{ type: "Http", url: "http://relay.test" }],
    });
    await engine.ready;

    await engine.sync();

    const state = engine.getSyncState();
    expect(state.type).toBe("SyncStateIsNotSynced");
    if (state.type === "SyncStateIsNotSynced") {
      expect(state.terminal).toBe(true);
    }
    engine.setTransports([]);
  });
});
