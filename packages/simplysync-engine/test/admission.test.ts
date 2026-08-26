import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createHlc, HLC_MAX_FUTURE_DRIFT_MS } from "@simplysync/protocol";

import { id, NonEmptyString, type SqliteDriver } from "../src/index";
import { createEngineState } from "../src/engine/state";
import { createClock, createStore } from "../src/engine/store";
import { createEventAdmission } from "../src/engine/admission";

// One ladder decides what happens to an arriving event, and these are its
// verdicts. Before this module the same question had three answers depending on
// which path delivered the event — a relay pull, a deferred replay, or a
// sibling tab — so the interesting property here is that there is now a single
// place to ask, and a test that needs no relay, no fake fetch, and no engine.

const schema = { note: { id: id("Note"), body: NonEmptyString } };

function makeAdmission(deviceId = "device-local") {
  const db = new Database(":memory:");
  const driver: SqliteDriver = {
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
  const state = createEngineState({ name: "admission" });
  state.driver = driver;
  state.deviceId = deviceId;
  const store = createStore(state, schema, { name: "admission" });
  store.ensureSchema();
  const clock = createClock(state, store);
  const admission = createEventAdmission(store, clock, schema);

  const deferredRow = (eventId: string) =>
    (db
      .prepare(`select retry_after_ms from _sync_deferred where event_id = ?`)
      .get(eventId) ?? null) as { retry_after_ms: number | null } | null;

  return { admission, store, clock, state, db, deferredRow };
}

function payload(hlc: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    table: "note",
    op: "upsert",
    rowId: "row-1",
    hlc,
    value: {
      body: "hello",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: hlc,
      isDeleted: 0,
    },
    ...overrides,
  };
}

const admit = (
  h: ReturnType<typeof makeAdmission>,
  eventId: string,
  raw: unknown,
) =>
  h.state.driver!.transaction(() =>
    h.admission.admit(eventId, raw, JSON.stringify(raw)),
  );

describe("event admission", () => {
  test("applies a well-formed event and reports the table that changed", () => {
    const h = makeAdmission();
    const hlc = createHlc("device-remote", Date.now(), 0);

    const outcome = admit(h, hlc, payload(hlc));

    expect(outcome).toEqual({ kind: "applied", table: "note" });
    expect(h.db.prepare(`select body from note where id = ?`).get("row-1"))
      .toEqual({ body: "hello" });
  });

  test("re-admitting the same event is unchanged, not applied twice", () => {
    // Last-writer-wins makes apply idempotent, and callers rely on the verdict
    // to tell a real change from a relay resend so they do not re-notify.
    const h = makeAdmission();
    const hlc = createHlc("device-remote", Date.now(), 0);

    expect(admit(h, hlc, payload(hlc)).kind).toBe("applied");
    expect(admit(h, hlc, payload(hlc))).toEqual({
      kind: "unchanged",
      table: "note",
    });
  });

  test("an event whose id disagrees with its own stamp is rejected", () => {
    // An event id IS its HLC. If they disagree the event cannot be ordered,
    // and no later build can repair that — the one class of authenticated
    // event that is genuinely discarded.
    const h = makeAdmission();
    const eventId = createHlc("device-remote", Date.now(), 0);
    const other = createHlc("device-remote", Date.now() - 5_000, 0);

    const outcome = admit(h, eventId, payload(other));

    expect(outcome).toEqual({ kind: "rejected" });
    expect(h.deferredRow(eventId)).toBeNull();
  });

  test("a payload that is not a payload is rejected", () => {
    const h = makeAdmission();
    const hlc = createHlc("device-remote", Date.now(), 0);

    expect(admit(h, hlc, { nonsense: true })).toEqual({ kind: "rejected" });
    expect(admit(h, hlc, "not an object")).toEqual({ kind: "rejected" });
  });

  test("an event stamped beyond the drift window is retained until it is due", () => {
    const h = makeAdmission();
    const future = createHlc(
      "device-remote",
      Date.now() + HLC_MAX_FUTURE_DRIFT_MS + 60_000,
      0,
    );

    const outcome = admit(h, future, payload(future));

    expect(outcome).toEqual({ kind: "deferred", reason: "futureClock" });
    // A due time, not opaque: wall time alone resolves this one.
    expect(h.deferredRow(future)?.retry_after_ms).toBeGreaterThan(Date.now());
  });

  test("an event for a table this build does not have is retained opaquely", () => {
    const h = makeAdmission();
    const hlc = createHlc("device-remote", Date.now(), 0);

    const outcome = admit(h, hlc, payload(hlc, { table: "invoice" }));

    expect(outcome).toEqual({ kind: "deferred", reason: "unknownTable" });
    // Opaque: no wall-clock retry can help, only an upgrade that adds the
    // table, so normal syncs must not keep reconsidering it.
    expect(h.deferredRow(hlc)?.retry_after_ms).toBeNull();
  });

  test("a payload version this build does not declare is retained opaquely", () => {
    const h = makeAdmission();
    const hlc = createHlc("device-remote", Date.now(), 0);

    const outcome = admit(h, hlc, payload(hlc, { schemaVersion: 99 }));

    expect(outcome).toEqual({ kind: "deferred", reason: "futureVersion" });
    expect(h.deferredRow(hlc)?.retry_after_ms).toBeNull();
  });

  test("a value that fails its column's own validation is retained and reported", () => {
    // Both properties matter: the event is the owner's authenticated data so
    // it is kept for a build that can write it, and it is still a genuine data
    // problem so the caller can keep it visible rather than retaining silently.
    const h = makeAdmission();
    const hlc = createHlc("device-remote", Date.now(), 0);

    const outcome = admit(
      h,
      hlc,
      payload(hlc, {
        value: {
          body: "", // NonEmptyString rejects this
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: hlc,
          isDeleted: 0,
        },
      }),
    );

    expect(outcome).toEqual({ kind: "deferred", reason: "applyFailed" });
    expect(h.deferredRow(hlc)?.retry_after_ms).toBeNull();
    expect(h.db.prepare(`select 1 from note where id = ?`).get("row-1"))
      .toBeNull();
  });

  test("admitting a previously deferred event clears it from the queue", () => {
    // The replay path hands back events it read from the queue, so a verdict
    // of applied has to retire the queue row or it replays forever.
    const h = makeAdmission();
    const hlc = createHlc("device-remote", Date.now(), 0);

    admit(h, hlc, payload(hlc, { table: "invoice" }));
    expect(h.deferredRow(hlc)).not.toBeNull();

    // The same event id, now describing a table this build does have.
    expect(admit(h, hlc, payload(hlc)).kind).toBe("applied");
    expect(h.deferredRow(hlc)).toBeNull();
  });

  test("absorbs a remote clock so the next local write sorts above it", () => {
    // observeHlc runs for every admitted event, including ones whose table
    // this build does not have — otherwise a later local write could sort
    // below an edit this device has already seen and lose the LWW compare.
    const h = makeAdmission();
    const ahead = createHlc("device-remote", Date.now() + 60_000, 0);

    admit(h, ahead, payload(ahead, { table: "invoice" }));

    expect(h.clock.nextHlc() > ahead).toBe(true);
  });
});
