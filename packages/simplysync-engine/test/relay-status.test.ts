import { describe, expect, test } from "bun:test";

import {
  createSync,
  id,
  NonEmptyString,
} from "../src/index";
import { memoryDriver, memoryStorage, settle } from "./support";

const schema = { note: { id: id("Note"), body: NonEmptyString } };
const waitUntil = async (predicate: () => boolean, message: string) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
};

const okPush = () =>
  new Response(JSON.stringify({ accepted: 0, duplicate: 0 }), { status: 200 });
const okPull = () =>
  new Response(JSON.stringify({ events: [], nextCursor: "" }), {
    status: 200,
  });

describe("getRelayStatuses", () => {
  test("transport replacement during an in-flight sync is contacted immediately after it", async () => {
    let releaseOldPull!: () => void;
    const oldPullBlocked = new Promise<void>((resolve) => {
      releaseOldPull = resolve;
    });
    let markOldPullStarted!: () => void;
    const oldPullStarted = new Promise<void>((resolve) => {
      markOldPullStarted = resolve;
    });
    let newRelayPulls = 0;
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") return okPush();
      if (url.includes("relay-old")) {
        markOldPullStarted();
        await oldPullBlocked;
        return okPull();
      }
      if (url.includes("relay-new")) {
        newRelayPulls += 1;
        return okPull();
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "relay-transport-replacement-test",
      transports: [{ url: "http://relay-old.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    await oldPullStarted;

    engine.setTransports([{ url: "http://relay-new.test" }]);
    expect(newRelayPulls).toBe(0);
    releaseOldPull();

    await waitUntil(
      () => newRelayPulls > 0,
      "replacement relay was not contacted after the in-flight sync",
    );
    expect(newRelayPulls).toBe(1);
    engine.setTransports([]);
  });

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
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "relay-status-test",
      transports: [
        { url: "http://relay-a.test" },
        { url: "http://relay-b.test" },
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
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "relay-status-partial-test",
      transports: [
        { url: "http://relay-good.test" },
        { url: "http://relay-bad.test" },
      ],
    });
    await engine.ready;

    await engine.sync();
    await settle(engine);

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
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "relay-status-prune-test",
      transports: [
        { url: "http://relay-good.test" },
        { url: "http://relay-bad.test" },
      ],
    });
    await engine.ready;
    await engine.sync();

    engine.setTransports([{ url: "http://relay-good.test" }]);
    const statuses = await engine.getRelayStatuses();
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.url).toContain("relay-good");
    expect(statuses[0]!.lastFailure).toBeUndefined();
  });
});

describe("failure classification", () => {
  // The poller's cadence is driven entirely by this taxonomy: a kind the user
  // or operator must act on (auth, quota, a rejected batch) backs off to five
  // minutes instead of re-sending the same doomed request every minute, while
  // a transient one keeps the normal cadence. Getting a status into the wrong
  // bucket is invisible until a battery complaint or a stalled account.
  const cases: Array<{
    status: number;
    kind: string;
    terminal: boolean;
  }> = [
    { status: 401, kind: "authRejected", terminal: true },
    { status: 403, kind: "authRejected", terminal: true },
    { status: 413, kind: "quotaExceeded", terminal: true },
    { status: 429, kind: "rateLimited", terminal: false },
    { status: 400, kind: "badRequest", terminal: true },
    { status: 500, kind: "serverError", terminal: false },
    { status: 503, kind: "serverError", terminal: false },
  ];

  for (const { status, kind, terminal } of cases) {
    test(`${status} is reported as ${kind}${terminal ? " (terminal)" : ""}`, async () => {
      const fetchStub = (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/health")) {
          return new Response(JSON.stringify({ version: "1.0.0" }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ error: "no" }), { status });
      }) as typeof fetch;

      const engine = createSync({
        createSqliteDriver: () => memoryDriver().driver,
        secureStorage: memoryStorage(),
        fetch: fetchStub,
      })(schema, {
        name: `classify-${status}`,
        transports: [{ url: "http://relay.test" }],
        syncIntervalMs: 3_600_000,
      });
      await engine.ready;
      await engine.sync();
      await settle(engine);

      const state = engine.getSyncState();
      expect(state.type).toBe("SyncStateIsNotSynced");
      expect((state as { kind?: string }).kind).toBe(kind);
      expect((state as { terminal?: boolean }).terminal).toBe(terminal);
      expect((state as { status?: number }).status).toBe(status);

      // The per-relay surface records the same kind, and a relay that answers
      // an error is still "not reachable" for status purposes.
      const [relay] = await engine.getRelayStatuses();
      expect(relay?.lastFailure?.kind).toBe(kind);
    });
  }

  test("a fetch that never reaches a relay is unreachable, not a bad request", async () => {
    // A rejected fetch carries no HTTP status at all. Classifying it as a 4xx
    // would mark it terminal and stop the poller from ever retrying a relay
    // that is merely down.
    const fetchStub = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "classify-network",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    await engine.sync();
    await settle(engine);

    const state = engine.getSyncState();
    expect((state as { kind?: string }).kind).toBe("unreachable");
    expect((state as { terminal?: boolean }).terminal).toBe(false);
  });

  test("a relay that recovers clears the failure without a restart", async () => {
    let failing = true;
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failing) return new Response("boom", { status: 500 });
      if (init?.method === "POST") return okPush();
      if (String(input).includes("/v1/status")) {
        return new Response(
          JSON.stringify({ server: { version: "1.0.0" }, account: {} }),
          { status: 200 },
        );
      }
      return okPull();
    }) as typeof fetch;

    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "classify-recovery",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    await engine.sync();
    await settle(engine);
    expect(engine.getSyncState().type).toBe("SyncStateIsNotSynced");

    failing = false;
    await engine.sync();
    await settle(engine);
    expect(engine.getSyncState().type).toBe("SyncStateIsSynced");
    const [relay] = await engine.getRelayStatuses();
    expect(relay?.lastFailure).toBeUndefined();
    expect(relay?.reachable).toBe(true);
  });
});

describe("poll cadence", () => {
  test("a terminal failure slows the poller; a healthy relay keeps the normal cadence", async () => {
    // The taxonomy only matters because of what it does to the poller. A relay
    // that answers 401 will answer 401 to the next request too, so re-sending
    // it every interval is pure battery and radio drain until someone re-auths.
    // Kept observable through fetch counts rather than internal state, because
    // the interval itself is private and the drain is the point.
    const POLL_MS = 15;
    const WINDOW_MS = 260;

    const run = async (name: string, status: number) => {
      let calls = 0;
      const fetchStub = (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/health")) {
          return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 });
        }
        calls += 1;
        if (status === 200) return okPull();
        return new Response(JSON.stringify({ error: "no" }), { status });
      }) as typeof fetch;

      const engine = createSync({
        createSqliteDriver: () => memoryDriver().driver,
        secureStorage: memoryStorage(),
        fetch: fetchStub,
      })(schema, {
        name,
        transports: [{ url: "http://relay.test" }],
        syncIntervalMs: POLL_MS,
      });
      await engine.ready;
      await engine.sync();
      await settle(engine);

      const baseline = calls;
      await new Promise((r) => setTimeout(r, WINDOW_MS));
      engine.setTransports([]); // stops the poller for this engine
      return calls - baseline;
    };

    // Healthy: the poller keeps firing across the window.
    const healthyPolls = await run("cadence-healthy", 200);
    expect(healthyPolls).toBeGreaterThanOrEqual(2);

    // Terminal: the interval jumps to five minutes, so nothing fires again.
    const terminalPolls = await run("cadence-terminal", 401);
    expect(terminalPolls).toBe(0);

    // Rate limiting is not terminal, but it backs off for the same reason.
    const rateLimitedPolls = await run("cadence-ratelimited", 429);
    expect(rateLimitedPolls).toBe(0);

    // A plain server error does self-heal, so the cadence is left alone.
    const serverErrorPolls = await run("cadence-server-error", 500);
    expect(serverErrorPolls).toBeGreaterThanOrEqual(2);
  });
});
