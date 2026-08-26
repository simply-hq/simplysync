// Two failure modes that used to be silent:
//
// 1. A relay that loses its data restarts its event `seq` counter, so a device
//    holding a higher pull cursor asks for `seq > cursor`, gets nothing back,
//    and reports "synced" forever while diverging from every peer.
// 2. `resetAppOwner` wiped local data and adopted a brand-new owner with no
//    checks at all — offline, that was unrecoverable loss with no prompt.
import { describe, expect, test } from "bun:test";

import {
  createSync,
  id,
  NonEmptyString,
} from "../src/index";
import { memoryDriver, memoryStorage } from "./support";

const schema = { note: { id: id("Note"), body: NonEmptyString } };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const okPush = () => json({ accepted: 1, duplicate: 0 });

describe("relay data loss", () => {
  test("a pull 404 after an advanced cursor resets the relay and re-seeds it", async () => {
    const pullCursors: string[] = [];
    let pushes = 0;
    let wiped = false;
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        pushes += 1;
        return okPush();
      }
      if (url.includes("/v1/events")) {
        pullCursors.push(new URL(url).searchParams.get("after") ?? "");
        // A wiped relay has forgotten the owner row, so it 404s an account it
        // previously served.
        return wiped
          ? json({ error: "Unknown owner" }, 404)
          : json({ events: [], nextCursor: "5" });
      }
      if (url.includes("/v1/status")) {
        return json({ server: { version: "1.0.0" }, account: { events: 1 } });
      }
      return json({ version: "1.0.0" });
    }) as typeof fetch;

    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "relay-wipe-test",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;

    engine.insert("note", { body: "keep me" });
    await engine.sync();
    await engine.sync();
    // The relay's cursor was adopted, so a later pull asks from there.
    expect(pullCursors).toContain("5");
    expect(pushes).toBeGreaterThan(0);

    wiped = true;
    await engine.sync();

    const [status] = await engine.getRelayStatuses();
    expect(status?.reseeding).toBe(true);

    // Repaired: the cursor is back to zero (not the stale "5" the relay can no
    // longer match) and the row is re-uploaded even though it was already
    // acknowledged once.
    const pushesBeforeReseed = pushes;
    pullCursors.length = 0;
    wiped = false;
    await engine.sync();
    expect(pushes).toBeGreaterThan(pushesBeforeReseed);
    expect(pullCursors[0]).toBe("");

    // A pass with nothing left to send means the copy is rebuilt.
    await engine.sync();
    const [settled] = await engine.getRelayStatuses();
    expect(settled?.reseeding).toBeUndefined();
    engine.setTransports([]);
  });

  test("a relay holding nothing behind our cursor is treated as wiped", async () => {
    // The other half of the detection: the relay kept the owner row (so pull
    // still answers 200) but its log was truncated or restored from an older
    // backup, which a 404 would never reveal. Needs `events: 0` as well as the
    // low headSeq, so a relay that merely compacted isn't re-seeded for nothing.
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") return okPush();
      if (url.includes("/v1/events")) return json({ events: [], nextCursor: "9" });
      if (url.includes("/v1/status")) {
        return json({
          server: { version: "1.0.0" },
          account: { headSeq: 2, events: 0 },
        });
      }
      return json({ version: "1.0.0" });
    }) as typeof fetch;

    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "relay-truncated-test",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    engine.insert("note", { body: "keep me" });
    await engine.sync();

    expect((await engine.getRelayStatuses())[0]?.reseeding).toBe(true);
    engine.setTransports([]);
  });
});

describe("resetAppOwner guard", () => {
  const makeEngine = (
    options: {
      fetch?: typeof fetch;
      transports?: { url: string }[];
      name: string;
    },
  ) =>
    createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: options.fetch,
    })(schema, {
      name: options.name,
      transports: options.transports ?? [],
      syncIntervalMs: 3_600_000,
    });

  test("refuses while local changes have not reached a relay", async () => {
    const engine = makeEngine({ name: "reset-pending" });
    await engine.ready;
    engine.insert("note", { body: "unsynced" });
    await expect(engine.resetAppOwner()).rejects.toThrow(
      /haven't reached a sync relay/,
    );
  });

  test("refuses on a relay-less device, pointing at a backup", async () => {
    const engine = makeEngine({ name: "reset-local-only" });
    await engine.ready;
    await expect(engine.resetAppOwner()).rejects.toThrow(
      /No sync relay is configured/,
    );
  });

  test("refuses when the relay is unreachable (the offline case)", async () => {
    const engine = makeEngine({
      name: "reset-offline",
      transports: [{ url: "http://relay.test" }],
      fetch: (async () => {
        throw new TypeError("Network request failed");
      }) as typeof fetch,
    });
    await engine.ready;
    await expect(engine.resetAppOwner()).rejects.toThrow(
      /could not be reached/,
    );
  });

  test("refuses when a reachable relay holds no copy of this owner", async () => {
    const engine = makeEngine({
      name: "reset-empty-relay",
      transports: [{ url: "http://relay.test" }],
      // Alive, but this owner has never pushed: status 404, /health answers.
      fetch: (async (input: RequestInfo | URL) =>
        String(input).includes("/v1/status")
          ? json({ error: "Unknown owner" }, 404)
          : json({ version: "1.0.0" })) as typeof fetch,
    });
    await engine.ready;
    await expect(engine.resetAppOwner()).rejects.toThrow(/holds a copy of this data yet/);
  });

  test("proceeds when a relay confirms it holds the data, and always under force", async () => {
    const confirmed = makeEngine({
      name: "reset-confirmed",
      transports: [{ url: "http://relay.test" }],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return okPush();
        if (String(input).includes("/v1/events")) {
          return json({ events: [], nextCursor: "" });
        }
        return json({ server: { version: "1.0.0" }, account: { events: 7 } });
      }) as typeof fetch,
    });
    await confirmed.ready;
    const before = (await confirmed.appOwner)?.id;
    await confirmed.resetAppOwner();
    expect((await confirmed.appOwner)?.id).not.toBe(before);
    confirmed.setTransports([]);

    // Force is the app's "the user confirmed" escape hatch and skips every check.
    const forced = makeEngine({ name: "reset-forced" });
    await forced.ready;
    forced.insert("note", { body: "unsynced" });
    await forced.resetAppOwner({ force: true });
    const rows = await forced.loadQuery(
      forced.createQuery((db) =>
        db.selectFrom("note").select(["id"]).where("isDeleted", "is not", 1),
      ),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("wipe detection does not fire on a healthy relay", () => {
  const engineWith = (name: string, fetchImpl: typeof fetch) =>
    createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: fetchImpl,
    })(schema, {
      name,
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });

  test("a relay that compacted below our cursor but still holds events is not re-seeded", async () => {
    // Stream compaction legitimately lowers max(seq) over the surviving rows.
    // Reading that as data loss would trigger a full re-upload on every
    // healthy relay that compacts — expensive, and on a metered account,
    // repeatedly so. An empty log is what separates the two.
    let pushes = 0;
    let headSeq = 40;
    let events = 9;
    const engine = engineWith("compaction-not-a-wipe", (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (init?.method === "POST") {
        pushes += 1;
        return okPush();
      }
      if (String(input).includes("/v1/status")) {
        return json({ server: { version: "1.0.0" }, account: { headSeq, events } });
      }
      return json({ events: [], nextCursor: "40" });
    }) as typeof fetch);
    await engine.ready;

    engine.insert("note", { body: "one" });
    await engine.sync();
    await engine.sync();
    expect(await status(engine)).toMatchObject({ reachable: true });
    const pushesBefore = pushes;

    // The relay compacts: head drops well below our cursor, but it still has data.
    headSeq = 3;
    expect((await status(engine)).reseeding).toBeUndefined();

    // …and only when the log is genuinely empty is it treated as a wipe.
    events = 0;
    expect((await status(engine)).reseeding).toBe(true);
    await engine.sync();
    expect(pushes).toBeGreaterThan(pushesBefore);
  });

  test("a legacy HLC-shaped cursor is ignored rather than compared as zero", async () => {
    // Databases from before the seq cursor hold an event id. Number() gives
    // NaN; any comparison against it is false, so wipe detection must skip it
    // instead of reading it as cursor 0 and declaring every relay healthy —
    // or, with the comparison the other way round, every relay wiped.
    const engine = engineWith("legacy-cursor", (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (init?.method === "POST") return okPush();
      if (String(input).includes("/v1/status")) {
        return json({ server: { version: "1.0.0" }, account: { headSeq: 0, events: 0 } });
      }
      return json({ events: [], nextCursor: "0000000005-0000-devA" });
    }) as typeof fetch);
    await engine.ready;

    engine.insert("note", { body: "one" });
    await engine.sync();
    await engine.sync();

    // Cursor is an HLC, headSeq is 0, the log is empty — every numeric
    // condition for "wiped" looks true, but the cursor cannot be compared.
    expect(await engine.getSyncLog(1)).toBeDefined();
    expect((await status(engine)).reseeding).toBeUndefined();
  });

  const status = async (engine: { getRelayStatuses: () => Promise<unknown[]> }) =>
    (await engine.getRelayStatuses())[0] as {
      reachable?: boolean;
      reseeding?: boolean;
    };
});
