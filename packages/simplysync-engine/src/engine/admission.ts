import {
  getHlcAdmissibility,
  HLC_MAX_FUTURE_DRIFT_MS,
  parseHlc,
  SYNC_SCHEMA_VERSION,
} from "@simplysync/protocol";
import type { SchemaDefinition } from "../engine-types.js";
import { classifySyncPayload } from "./schema-version.js";
import type { Clock, Store } from "./store.js";

/**
 * Why an event was retained rather than applied. Deferral is not a failure —
 * every reason here is one a later moment can resolve — but `applyFailed` is
 * the one that also indicates a genuine data problem worth reporting, so
 * callers can keep it visible in the sync log instead of retaining it silently.
 */
export type DeferReason =
  | "futureVersion"
  | "futureClock"
  | "clockRefused"
  | "unknownTable"
  | "applyFailed";

/**
 * What happened to one event. `applied` and `unchanged` both mean the event was
 * admitted and is finished with; they differ only in whether last-writer-wins
 * kept the incoming row, which callers need for change notification and for
 * deciding what to forward to other tabs.
 */
export type AdmissionOutcome =
  | { readonly kind: "applied"; readonly table: string }
  | { readonly kind: "unchanged"; readonly table: string }
  | { readonly kind: "deferred"; readonly reason: DeferReason }
  | { readonly kind: "rejected" };

export type EventAdmission = ReturnType<typeof createEventAdmission>;

/**
 * The single answer to "an event arrived — may it touch the database?".
 *
 * Events reach a device three ways: pulled from a relay, replayed from the
 * deferred queue after an upgrade, and broadcast by a sibling tab. All three
 * must reach the same verdict, because they carry the same events — a relay
 * pull on the leader and the broadcast of that same event to a follower are
 * one event arriving at two databases. This module was extracted because they
 * had drifted into three: a clock-refused event was terminally dropped on the
 * pull path, retried forever on the replay path, and silently discarded (along
 * with its outbox marker) on the tab path.
 *
 * The unified rule is retain-and-retry. An event that decrypted and
 * authenticated is the owner's own data; the only outcomes that discard it are
 * structural — a payload that is not a payload, or a stamp that cannot be
 * ordered. Everything else is deferred, because every other reason to refuse
 * is transient: a wall clock catches up, an app upgrade learns a table. This
 * is also what the Kotlin and Swift ports already do, so the ladder now
 * converges rather than diverging from them.
 *
 * The module owns the bookkeeping as well as the decision. Returning a verdict
 * alone would leave the same five-branch switch at each of the three call
 * sites, which relocates the divergence rather than removing it. Both queue
 * calls are idempotent for callers whose event was never deferred, so one
 * ladder serves all three paths.
 *
 * Every entry point must be called inside a driver transaction: it writes the
 * row, the deferred queue, and the clock's high-water mark, and a partial
 * commit of those would leave the clock ahead of the data it absorbed.
 */
export function createEventAdmission(
  store: Store,
  clock: Clock,
  schema: SchemaDefinition,
  schemaVersion: number = SYNC_SCHEMA_VERSION,
) {
  // The earliest wall time at which a future-stamped event becomes admissible.
  // Retrying before then just re-defers it.
  const futureRetryAfter = (eventId: string, payloadHlc: string): number => {
    const eventMillis = parseHlc(eventId)?.millis ?? 0;
    const payloadMillis = parseHlc(payloadHlc)?.millis ?? 0;
    return Math.max(eventMillis, payloadMillis) - HLC_MAX_FUTURE_DRIFT_MS;
  };

  // Opaque: retained with no retry time, so only the bounded once-per-schema
  // rescan reconsiders it. Used when only new code can make sense of the event.
  const deferOpaque = (
    eventId: string,
    payloadJson: string,
    reason: DeferReason,
  ): AdmissionOutcome => {
    store.deferRemoteEvent(eventId, payloadJson, null);
    return { kind: "deferred", reason };
  };

  const deferUntil = (
    eventId: string,
    payloadJson: string,
    retryAfterMs: number,
    reason: DeferReason,
  ): AdmissionOutcome => {
    store.deferRemoteEvent(eventId, payloadJson, retryAfterMs);
    return { kind: "deferred", reason };
  };

  // Structurally unusable, and no future version of this app can fix it.
  const reject = (eventId: string): AdmissionOutcome => {
    store.dropDeferredEvent(eventId);
    return { kind: "rejected" };
  };

  /**
   * Run the admission ladder for one event and carry out its verdict.
   *
   * `payloadJson` is what gets retained if the event is deferred, so it must be
   * the event's own serialized payload, not a re-encoding of a projection.
   */
  const admit = (
    eventId: string,
    rawPayload: unknown,
    payloadJson: string,
  ): AdmissionOutcome => {
    const classified = classifySyncPayload(rawPayload, schemaVersion);
    if (classified.kind === "invalid") return reject(eventId);
    // A payload version this app does not declare support for must not be
    // projected through an older schema whose field meanings may differ.
    if (classified.kind === "future") {
      return deferOpaque(eventId, payloadJson, "futureVersion");
    }

    const payload = classified.payload;
    const eventHlc = getHlcAdmissibility(eventId);
    const payloadHlc = getHlcAdmissibility(payload.hlc);

    // An event id IS its HLC. A mismatch or an unparseable stamp cannot be
    // ordered, and last-writer-wins has nothing to compare — no upgrade fixes
    // that, so it is the one class of authenticated event we discard.
    if (
      eventHlc === "malformed"
      || payloadHlc === "malformed"
      || payload.hlc !== eventId
    ) {
      return reject(eventId);
    }

    // Stamped beyond the drift window. Retain until wall time catches up:
    // discarding would trade clock poisoning for silent data loss.
    if (eventHlc === "future" || payloadHlc === "future") {
      return deferUntil(
        eventId,
        payloadJson,
        futureRetryAfter(eventId, payload.hlc),
        "futureClock",
      );
    }

    // Absorb the sender's time even for tables this app does not have, so a
    // later local write always sorts above what this device has already seen.
    // A refusal here means the clock would not take the value; retry shortly
    // rather than dropping the event, which is what the pull path used to do.
    if (!clock.observeHlc(payload.hlc)) {
      return deferUntil(
        eventId,
        payloadJson,
        Math.max(Date.now() + 1_000, futureRetryAfter(eventId, payload.hlc)),
        "clockRefused",
      );
    }

    // A table this build does not declare. Retained verbatim for the upgrade
    // that introduces it.
    if (!(payload.table in schema)) {
      return deferOpaque(eventId, payloadJson, "unknownTable");
    }

    try {
      const wrote = store.applyLwwRow(payload);
      store.dropDeferredEvent(eventId);
      return wrote
        ? { kind: "applied", table: payload.table }
        : { kind: "unchanged", table: payload.table };
    } catch {
      // Structurally valid but unwritable against the local schema — a column
      // this build lacks, or a value that fails its own type's validation.
      // Retained rather than discarded, because a later build may widen the
      // column and the event is the owner's own authenticated data. Opaque
      // rather than due, so it cannot sit at the front of every due page and
      // starve events that are merely waiting on the wall clock. Callers
      // surface this reason in the sync log — a genuine data problem should
      // stay visible even though nothing is lost.
      return deferOpaque(eventId, payloadJson, "applyFailed");
    }
  };

  return { admit };
}
