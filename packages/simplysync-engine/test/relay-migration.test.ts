// Moving an owner between relays — including swapping one relay
// implementation (Go, Cloudflare) for another.
//
// A pull cursor is a position in ONE relay's sequence, not a position in the
// owner's log. Carrying one to a relay that numbers events differently skips
// everything at or below it, with a 200 and no error. The cross-relay
// conformance suite proves that is exactly what the two relays do to each
// other; these tests cover what the engine does about it.
//
// The wipe-detection cases (pull 404, and a relay holding nothing behind our
// cursor) live in relay-wipe-recovery.test.ts. What is here is the migration
// shape that detection deliberately does NOT catch.
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

const GO = "http://go.relay.test";
const CF = "http://cf.relay.test";

/** Records, per relay base URL, every push and every pull cursor asked for. */
function makeRecorder(
  reply: (base: string, cursor: string) => Response = () =>
    json({ events: [], nextCursor: "" }),
) {
  const pushes: string[] = [];
  const pulls: { base: string; cursor: string }[] = [];
  const baseOf = (url: string) => (url.startsWith(GO) ? GO : CF);

  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const base = baseOf(url);
    if (init?.method === "POST") {
      pushes.push(base);
      return okPush();
    }
    if (url.includes("/v1/events")) {
      const cursor = new URL(url).searchParams.get("after") ?? "";
      pulls.push({ base, cursor });
      return reply(base, cursor);
    }
    if (url.includes("/v1/status")) {
      return json({ server: { version: "1.0.0" }, account: { events: 1 } });
    }
    return json({ version: "1.0.0" });
  }) as typeof fetch;

  return { fetchStub, pushes, pulls };
}

function makeEngine(fetchStub: typeof fetch, name: string, url: string) {
  return createSync({
    createSqliteDriver: () => memoryDriver().driver,
    secureStorage: memoryStorage(),
    fetch: fetchStub,
  })(schema, {
    name,
    transports: [{ url }],
    syncIntervalMs: 3_600_000,
  });
}

describe("migrating between relays", () => {
  test("a new relay URL starts from a clean cursor and gets its own copy", async () => {
    // Relays number events independently, so the position reached on one is
    // meaningless on the next. Switching must re-pull from the beginning (the
    // seen-set dedupes) rather than inherit a cursor that would skip history.
    const { fetchStub, pushes, pulls } = makeRecorder((base, cursor) =>
      // The old relay hands back a high cursor; the new one must never see it.
      json({ events: [], nextCursor: base === GO ? "5000" : cursor || "1" }),
    );
    const engine = makeEngine(fetchStub, "relay-switch", GO);
    await engine.ready;

    engine.insert("note", { body: "written before the migration" });
    await engine.sync();
    await engine.sync();
    expect(pushes).toContain(GO);
    expect(pulls.some((p) => p.base === GO && p.cursor === "5000")).toBe(true);

    engine.setTransports([{ url: CF }]);
    await engine.sync();

    const cfPulls = pulls.filter((p) => p.base === CF);
    expect(cfPulls.length).toBeGreaterThan(0);
    // The decisive assertion: the first thing asked of the new relay is the
    // start of its log, not the old relay's position.
    expect(cfPulls[0]?.cursor).toBe("");
    expect(cfPulls.every((p) => p.cursor !== "5000")).toBe(true);
    // And the row is re-uploaded — an acknowledgement from the old relay is
    // not evidence the new one holds anything.
    expect(pushes).toContain(CF);

    engine.setTransports([]);
  });

  test("switching back does not resurrect the first relay's stale cursor", async () => {
    // A device that moves Go -> Cloudflare -> Go must not reuse the cursor it
    // held before the round trip: the original relay may have been rebuilt in
    // the meantime, which is usually why the owner moved away and back.
    const { fetchStub, pulls } = makeRecorder((base, cursor) =>
      json({ events: [], nextCursor: cursor === "" ? "7" : cursor }),
    );
    const engine = makeEngine(fetchStub, "relay-round-trip", GO);
    await engine.ready;

    engine.insert("note", { body: "round trip" });
    await engine.sync();
    await engine.sync();

    engine.setTransports([{ url: CF }]);
    await engine.sync();
    engine.setTransports([{ url: GO }]);
    pulls.length = 0;
    await engine.sync();

    // Returning to Go resumes from Go's own cursor — per-relay state survived
    // the detour instead of being clobbered by Cloudflare's.
    expect(pulls.filter((p) => p.base === GO)[0]?.cursor).toBe("7");
    engine.setTransports([]);
  });

  test("swapping the implementation behind one URL leaves a silent gap", async () => {
    // The migration shape with no detection behind it, and the reason to move
    // a relay by changing its URL rather than by re-pointing the same one.
    //
    // The sync pass pushes before it pulls, so the swapped-in relay has an
    // owner row by the time the pull lands: no 404, so the pull-side wipe
    // check never fires. Its log is not empty either, so the status-side check
    // (which requires events === 0, deliberately, so ordinary compaction
    // doesn't force a re-seed) also stays quiet. The device therefore asks the
    // new relay for "everything after 900" and is told there is nothing —
    // while events 1..900 on that relay are never seen.
    let swapped = false;
    const served: string[] = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") return okPush();
      if (url.includes("/v1/events")) {
        const cursor = new URL(url).searchParams.get("after") ?? "";
        served.push(cursor);
        // Before the swap the relay's head is 900. After it, a different
        // implementation holds the same owner but numbered from 1.
        return json({ events: [], nextCursor: swapped ? cursor : "900" });
      }
      if (url.includes("/v1/status")) {
        return json({
          server: { version: "1.0.0" },
          // A populated relay: headSeq below our cursor, but NOT empty.
          account: swapped
            ? { headSeq: 12, events: 12 }
            : { headSeq: 900, events: 900 },
        });
      }
      return json({ version: "1.0.0" });
    }) as typeof fetch;

    const engine = makeEngine(fetchStub, "relay-backend-swap", GO);
    await engine.ready;
    engine.insert("note", { body: "before the swap" });
    await engine.sync();
    await engine.sync();
    expect(served).toContain("900");

    swapped = true;
    served.length = 0;
    await engine.sync();
    await engine.getRelayStatuses();

    // Documents the gap rather than claiming it is handled: the device keeps
    // asking from 900, and does not flag the relay for re-seeding.
    expect(served.length).toBeGreaterThan(0);
    expect(served.every((cursor) => cursor === "900")).toBe(true);
    expect((await engine.getRelayStatuses())[0]?.reseeding).toBeUndefined();

    engine.setTransports([]);
  });
});
