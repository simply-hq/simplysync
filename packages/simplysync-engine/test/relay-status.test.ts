import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createSync,
  id,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
} from "../src/index";

function makeDriver(): SqliteDriver {
  const db = new Database(":memory:");
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
const settle = () => new Promise((r) => setTimeout(r, 25));

const okPush = () =>
  new Response(JSON.stringify({ accepted: 0, duplicate: 0 }), { status: 200 });
const okPull = () =>
  new Response(JSON.stringify({ events: [], nextCursor: "" }), {
    status: 200,
  });

describe("getRelayStatuses", () => {
  test("reports the /v1/status storage snapshot per relay, with /health fallback for empty accounts", async () => {
    // relay-a has an account (usage + quota); relay-b has never seen this
    // owner (404 on status) but is alive (/health answers).
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") return okPush();
      if (url.includes("/v1/status")) {
        if (url.includes("relay-a")) {
          return new Response(
            JSON.stringify({
              server: { version: "1.0.0", serverTime: "2026-01-01T00:00:00Z" },
              account: {
                quotaBytes: 1073741824,
                usedBytes: 52428800,
                usedPct: 4.88,
                headSeq: 42,
                streams: 7,
                events: 21,
              },
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/health")) {
        return new Response(
          JSON.stringify({ ok: true, version: "0.9.0" }),
          { status: 200 },
        );
      }
      return okPull();
    }) as typeof fetch;

    const engine = createSync({
      createSqliteDriver: () => makeDriver(),
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "relay-status-test",
      transports: [
        { type: "Http", url: "http://relay-a.test" },
        { type: "Http", url: "http://relay-b.test" },
      ],
    });
    await engine.ready;

    const statuses = await engine.getRelayStatuses();
    expect(statuses.length).toBe(2);

    const a = statuses.find((s) => s.url.includes("relay-a"))!;
    expect(a.reachable).toBe(true);
    expect(a.usedBytes).toBe(52428800);
    expect(a.quotaBytes).toBe(1073741824);
    expect(a.usedPct).toBeCloseTo(4.88);
    expect(a.headSeq).toBe(42);
    expect(a.streams).toBe(7);
    expect(a.events).toBe(21);
    expect(a.version).toBe("1.0.0");

    const b = statuses.find((s) => s.url.includes("relay-b"))!;
    expect(b.reachable).toBe(true); // alive, just no account yet
    expect(b.usedBytes).toBeUndefined();
    expect(b.quotaBytes).toBeUndefined();
    expect(b.version).toBe("0.9.0");
  });

  test("a failing relay stays visible per-relay while another relay keeps SyncState green", async () => {
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("relay-bad")) {
        return new Response("boom", { status: 500 });
      }
      if (init?.method === "POST") return okPush();
      if (url.includes("/v1/status")) {
        return new Response(
          JSON.stringify({
            server: { version: "1.0.0" },
            account: { quotaBytes: 100, usedBytes: 1, usedPct: 1 },
          }),
          { status: 200 },
        );
      }
      return okPull();
    }) as typeof fetch;

    const engine = createSync({
      createSqliteDriver: () => makeDriver(),
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "relay-status-partial-test",
      transports: [
        { type: "Http", url: "http://relay-good.test" },
        { type: "Http", url: "http://relay-bad.test" },
      ],
    });
    await engine.ready;

    await engine.sync();
    await settle();

    // One healthy relay is enough for the collapsed state…
    expect(engine.getSyncState().type).toBe("SyncStateIsSynced");

    // …but the per-relay surface still shows which relay is failing and why.
    const statuses = await engine.getRelayStatuses();
    const good = statuses.find((s) => s.url.includes("relay-good"))!;
    expect(good.reachable).toBe(true);
    expect(good.lastSyncedAt).toBeDefined();
    expect(good.lastFailure).toBeUndefined();

    const bad = statuses.find((s) => s.url.includes("relay-bad"))!;
    expect(bad.reachable).toBe(false);
    expect(bad.lastFailure?.kind).toBe("serverError");
    expect(bad.lastSyncedAt).toBeUndefined();
  });

  test("dropping a relay from transports drops its lingering health entry", async () => {
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("relay-bad")) return new Response("boom", { status: 500 });
      if (init?.method === "POST") return okPush();
      if (url.includes("/v1/status")) return new Response("not found", { status: 404 });
      if (url.includes("/health"))
        return new Response(JSON.stringify({ ok: true, version: "1.0.0" }), {
          status: 200,
        });
      return okPull();
    }) as typeof fetch;

    const engine = createSync({
      createSqliteDriver: () => makeDriver(),
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "relay-status-prune-test",
      transports: [
        { type: "Http", url: "http://relay-good.test" },
        { type: "Http", url: "http://relay-bad.test" },
      ],
    });
    await engine.ready;
    await engine.sync();

    engine.setTransports([{ type: "Http", url: "http://relay-good.test" }]);
    const statuses = await engine.getRelayStatuses();
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.url).toContain("relay-good");
    expect(statuses[0]!.lastFailure).toBeUndefined();
  });
});
