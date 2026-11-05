// Two things a device does for its relays beyond pushing its own writes:
// carry what one relay delivered to the others (relays never talk to each
// other), and notice when a relay has been rebuilt under the same URL (its
// `epoch` changes) so it re-seeds that relay even though the cursor still
// "works". Both are driven through stub relays that behave like the reference
// ones: a per-relay seq cursor, dedupe on eventId, and an epoch per database.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createHlc,
  createMnemonic,
  deriveIdentity,
  encryptPayload,
  type SyncEnvelope,
} from "@simplysync/protocol";
import { createSync, id, NonEmptyString } from "../src/index";
import { memoryDriver, memoryStorage, settle } from "./support";

const MNEMONIC = createMnemonic();
const schema = { note: { id: id("Note"), body: NonEmptyString } };

interface StubRelay {
  readonly url: string;
  events: SyncEnvelope[];
  epoch: string;
  /** Event ids accepted by push, in arrival order (duplicates excluded). */
  readonly pushed: string[];
  /** Lose everything, as a fresh deploy would: new log, new epoch. */
  wipe(): void;
}

function stubRelays(names: readonly string[]) {
  const relays = new Map<string, StubRelay>();
  for (const name of names) {
    const relay: StubRelay = {
      url: `http://${name}.test`,
      events: [],
      epoch: `${name}-epoch-1`,
      pushed: [],
      wipe() {
        this.events = [];
        this.epoch = `${name}-epoch-2`;
      },
    };
    relays.set(name, relay);
  }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const relay = relays.get(url.hostname.replace(/\.test$/u, ""))!;
    if (url.pathname !== "/v1/events") return new Response("nope", { status: 404 });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { events: SyncEnvelope[] };
      let accepted = 0;
      for (const event of body.events) {
        if (relay.events.some((e) => e.eventId === event.eventId)) continue;
        relay.events.push(event);
        relay.pushed.push(event.eventId);
        accepted += 1;
      }
      return Response.json({ accepted, duplicate: body.events.length - accepted });
    }
    const after = Number(url.searchParams.get("after") ?? "0") || 0;
    const slice = relay.events.slice(after);
    return Response.json({
      events: slice,
      nextCursor: String(after + slice.length),
      epoch: relay.epoch,
    });
  }) as typeof fetch;
  return { relays, fetch: fetchImpl };
}

function makeDevice(fetchImpl: typeof fetch, name: string) {
  const db = new Database(":memory:");
  const engine = createSync({
    createSqliteDriver: () => memoryDriver(db).driver,
    secureStorage: memoryStorage(),
    fetch: fetchImpl,
  })(schema, {
    name,
    externalAppOwner: { id: "", mnemonic: MNEMONIC, writeKey: "" },
    syncIntervalMs: 3_600_000,
  });
  return { engine, db };
}

/** An envelope some OTHER device authored and pushed to `relay`. */
async function remoteEvent(relay: StubRelay, rowId: string, body: string) {
  const identity = await deriveIdentity(MNEMONIC);
  const hlc = createHlc("device-remote", Date.now() - 10_000, 0);
  const envelope = await encryptPayload(
    identity,
    { eventId: hlc, deviceId: "device-remote" },
    {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc,
      value: {
        id: rowId,
        body,
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    },
  );
  relay.events.push(envelope);
  return hlc;
}

const outboxCount = (db: Database): number =>
  (db.prepare("select count(*) as c from _sync_outbox").get() as { c: number }).c;

const meta = (db: Database, key: string): string | null =>
  (db.prepare("select value from _sync_meta where key = ?").get(key) as
    | { value: string }
    | null)?.value ?? null;

describe("forwarding between relays", () => {
  test("an event pulled from one relay is pushed to the other, once", async () => {
    const { relays, fetch } = stubRelays(["a", "b"]);
    const a = relays.get("a")!;
    const b = relays.get("b")!;
    const eventId = await remoteEvent(a, "r1", "from another device");

    const { engine, db } = makeDevice(fetch, "fwd-two");
    await engine.ready;
    engine.setTransports([{ url: a.url }, { url: b.url }]);
    await settle(engine);
    await engine.sync();

    // Applied locally…
    expect(engine.getQueryRows(engine.createQuery((q) => q.selectFrom("note").select("body")))).toEqual([
      { body: "from another device" },
    ]);
    // …carried to b, and never echoed back to a, which already has it.
    expect(b.pushed).toEqual([eventId]);
    expect(a.pushed).toEqual([]);

    // Delivered to every relay it was not pulled from: pruned, not re-sent.
    await engine.sync();
    expect(b.pushed).toEqual([eventId]);
    expect(outboxCount(db)).toBe(0);
  });

  test("with a single relay nothing is queued for forwarding", async () => {
    const { relays, fetch } = stubRelays(["a"]);
    const a = relays.get("a")!;
    await remoteEvent(a, "r1", "solo");

    const { engine, db } = makeDevice(fetch, "fwd-one");
    await engine.ready;
    engine.setTransports([{ url: a.url }]);
    await settle(engine);
    await engine.sync();

    expect(outboxCount(db)).toBe(0);
  });

  test("this device's own events are not forwarded when pulled back", async () => {
    const { relays, fetch } = stubRelays(["a", "b"]);
    const a = relays.get("a")!;
    const b = relays.get("b")!;

    const { engine } = makeDevice(fetch, "fwd-own");
    await engine.ready;
    engine.setTransports([{ url: a.url }, { url: b.url }]);
    await settle(engine);
    expect(engine.insert("note", { body: "mine" }).ok).toBe(true);
    await engine.sync();
    expect(a.pushed.length).toBe(1);
    expect(b.pushed.length).toBe(1);

    // The next pull hands this device its own event back from both relays.
    await engine.sync();
    await engine.sync();
    expect(a.pushed.length).toBe(1);
    expect(b.pushed.length).toBe(1);
  });
});

describe("relay epoch", () => {
  test("a changed epoch under the same URL re-seeds the relay", async () => {
    const { relays, fetch } = stubRelays(["a"]);
    const a = relays.get("a")!;

    const { engine, db } = makeDevice(fetch, "epoch-wipe");
    await engine.ready;
    engine.setTransports([{ url: a.url }]);
    await settle(engine);
    expect(engine.insert("note", { body: "keep me" }).ok).toBe(true);
    await engine.sync();
    expect(a.events.length).toBe(1);
    expect(meta(db, `epoch:${a.url}`)).toBe("a-epoch-1");

    // Fresh deploy: the log is gone, but pulls still answer 200 and the
    // time-anchored counter keeps the stale cursor "working".
    a.wipe();
    await engine.sync();

    expect(a.events.map((e) => e.eventId)).toEqual([a.pushed[0]!]);
    expect(a.pushed.length).toBe(2); // the original push, then the re-seed
    expect(meta(db, `epoch:${a.url}`)).toBe("a-epoch-2");
  });

  test("a stable epoch never triggers a re-seed", async () => {
    const { relays, fetch } = stubRelays(["a"]);
    const a = relays.get("a")!;

    const { engine } = makeDevice(fetch, "epoch-stable");
    await engine.ready;
    engine.setTransports([{ url: a.url }]);
    await settle(engine);
    expect(engine.insert("note", { body: "once" }).ok).toBe(true);
    await engine.sync();
    await engine.sync();
    await engine.sync();
    expect(a.pushed.length).toBe(1);
  });

  test("a relay without an epoch keeps the 404-based detection only", async () => {
    const { relays, fetch } = stubRelays(["a"]);
    const a = relays.get("a")!;
    a.epoch = "";

    const { engine, db } = makeDevice(fetch, "epoch-none");
    await engine.ready;
    engine.setTransports([{ url: a.url }]);
    await settle(engine);
    expect(engine.insert("note", { body: "legacy relay" }).ok).toBe(true);
    await engine.sync();
    await engine.sync();
    expect(a.pushed.length).toBe(1);
    expect(meta(db, `epoch:${a.url}`)).toBeNull();
  });
});
