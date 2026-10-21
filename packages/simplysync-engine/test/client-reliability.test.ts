import { expect, test } from "bun:test";

import { createSync, id, NonEmptyString } from "../src/index";
import { memoryDriver, memoryStorage } from "./support";

const schema = { note: { id: id("Note"), body: NonEmptyString } };

let seq = 0;
function makeEngine(
  fetchImpl: typeof fetch,
  extra: { requestTimeoutMs?: number } = {},
) {
  return createSync({
    createSqliteDriver: () => memoryDriver().driver,
    secureStorage: memoryStorage(),
    fetch: fetchImpl,
  })(schema, {
    name: `client-reliability-${seq++}`,
    transports: [{ url: "http://relay.test" }],
    autoSync: false,
    ...extra,
  });
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// A relay that answers push and pull with an empty, healthy response.
const healthyRelay = (calls: string[]): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (init?.method === "POST") return ok({ accepted: 0, duplicate: 0 });
    return ok({ events: [], nextCursor: "" });
  }) as typeof fetch;

test("a hung relay request times out instead of stalling sync for good", async () => {
  let hang = true;
  const calls: string[] = [];
  const healthy = healthyRelay(calls);
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!hang) return healthy(input, init);
    // Never answers; only the engine's deadline can end it.
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal!.reason),
      );
    });
  }) as typeof fetch;

  const engine = makeEngine(fetchImpl, { requestTimeoutMs: 50 });
  await engine.ready;
  engine.insert("note", { body: "queued" });

  await engine.sync();
  const state = engine.getSyncState();
  expect(state.type).toBe("SyncStateIsNotSynced");
  if (state.type === "SyncStateIsNotSynced") expect(state.kind).toBe("timeout");

  // The stuck pass is over, so the next sync actually runs.
  hang = false;
  await engine.sync();
  expect(engine.getSyncState().type).toBe("SyncStateIsSynced");
  expect(calls).toContain("POST /v1/events");
  engine.close();
});

test("a throwing subscriber cannot fail a committed write or a sync pass", async () => {
  const calls: string[] = [];
  const engine = makeEngine(healthyRelay(calls));
  await engine.ready;
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    engine.subscribeSyncState(() => {
      throw new Error("app bug");
    });
    const query = engine.createQuery((db) =>
      db.selectFrom("note").selectAll().where("isDeleted", "=", 0),
    );
    await engine.loadQuery(query);
    engine.subscribeQuery(query)(() => {
      throw new Error("app bug");
    });

    const written = engine.insert("note", { body: "kept" });
    expect(written.ok).toBe(true);
    expect((await engine.loadQuery(query)).length).toBe(1);

    await engine.sync();
    expect(engine.getSyncState().type).toBe("SyncStateIsSynced");
    expect(engine.getPendingOutboxCount()).toBe(0);
    // Reported, not swallowed.
    expect(errors.length).toBeGreaterThan(0);
  } finally {
    console.error = originalError;
    engine.close();
  }
});

test("close() stops relay traffic but keeps local writes working", async () => {
  const calls: string[] = [];
  const engine = makeEngine(healthyRelay(calls));
  await engine.ready;
  engine.close();
  engine.close(); // idempotent

  expect(engine.insert("note", { body: "offline" }).ok).toBe(true);
  await engine.sync();
  expect(calls).toEqual([]);
  expect(engine.getPendingOutboxCount()).toBe(1);
});

test("close() before boot finishes still leaves nothing running", async () => {
  const calls: string[] = [];
  const engine = createSync({
    createSqliteDriver: () => memoryDriver().driver,
    secureStorage: memoryStorage(),
    fetch: healthyRelay(calls),
  })(schema, {
    name: `client-reliability-${seq++}`,
    transports: [{ url: "http://relay.test" }],
  });
  engine.close();
  await engine.ready;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toEqual([]);
});

test("restoring a closed owner says it was retired, and changes nothing", async () => {
  const engine = makeEngine((async () =>
    new Response(JSON.stringify({ error: "Owner closed" }), {
      status: 410,
    })) as unknown as typeof fetch);
  await engine.ready;
  const before = (await engine.appOwner)?.id;

  const other = makeEngine(healthyRelay([]));
  await other.ready;
  const leaked = (await other.appOwner)!.recoveryKey;
  other.close();

  await expect(engine.restoreAppOwner(leaked)).rejects.toThrow(/retired/);
  expect((await engine.appOwner)?.id).toBe(before);
  engine.close();
});
