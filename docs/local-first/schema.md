# Schema evolution

Users don't upgrade at the same moment. A phone still on last month's build and
a laptop on today's share one relay, and both keep writing. So the engine never
runs migration scripts against a user's database: **the schema only grows**, and
every app version has to cope with data from the versions before and after it.

The short version:

| Change | Safe? | Do this |
| --- | --- | --- |
| Add a table | Yes | Just add it. |
| Add a column | Yes | Declare it `nullOr(...)` or `withDefault(...)` — see [New columns are NULL on old rows](#new-columns-are-null-on-old-rows). |
| Add an index | Yes | Add it to `indexes`. |
| Relax a constraint (longer text, wider range) | With care | Older builds hold values they still reject — see [Changing a column type](#changing-a-column-type). |
| Rename a table or column | No | Add the new one and read both. |
| Remove a table or column | No | Keep it declared; stop writing it. |
| Change a column's type | No | Add a new column with the new type. |
| Change what an existing field means | With care | Bump `schemaVersion` — and read [what that costs](#when-to-bump-schemaversion) first. |

## What happens on upgrade

On every boot the engine reconciles the local database with the schema you pass
it: it creates missing tables, adds missing columns (`ALTER TABLE … ADD COLUMN`),
and creates missing indexes. It **never renames or drops** anything, so a
database only ever accumulates columns. There is no migration step to write and
none to run.

## When an older app meets newer data

Every event a device pulls passes one admission check before it may touch a row
(`engine/admission.ts`, shared by the TypeScript, Swift, and Kotlin engines). An
event that decrypts and authenticates is the owner's own data, so the engine
discards it only when it is structurally broken — not a payload at all, or
stamped with an HLC that can't be ordered. Anything a later moment could resolve
is **held** instead:

| The event… | What an older app does |
| --- | --- |
| declares a higher `schemaVersion` than this build | Holds it unapplied. It never reads a newer meaning through older code. |
| targets a table this build doesn't have | Holds it until an upgrade adds the table. |
| has a value this build's column type rejects | Holds it, and records `applyFailed` in the sync log. |
| carries a column this build doesn't have | Applies the row and drops just that column. |
| is stamped more than five minutes in the future | Holds it until the wall clock catches up — see [Sync & the relay](./sync.md). |

Held events live in the local `_sync_deferred` table and are retried every time
the app starts, so the first launch after an upgrade that adds support applies
them. Nothing is lost while an app is behind; it just doesn't see what it can't
understand yet.

### An older app editing a row with a newer column

This is safe. An edit's payload is the device's whole row — every column *that
device* has — and applying a payload only sets the columns it contains. An older
app's row has no `dueDate`, so its edits never mention one, and a newer device
keeps the `dueDate` it already had.

### Caveat: relay compaction

Both reference relays compact their logs on a schedule (every six hours by
default), keeping only each row's **newest** event. If that newest event
came from an app version that predates a column, any device that pulls the row
afterwards — a fresh install, a restore, a device that was offline — gets it
without that column's value. Devices that already had the value keep it, and
their next edit of the row sends it again.

So during a rollout, a new column's value is only as durable as the newest
writer of each row is up to date. If a column has to survive a restore, get users
onto the new version before relying on it.

## New columns are NULL on old rows

SQLite has no value for a column on rows written before it existed, or on rows
written by an app version that predates it, so those rows read `NULL`. Queries
don't validate values on read: a column you typed `NonEmptyString` still comes
back `NULL` for those rows, and the type checker won't warn you.

Declare new columns so that's explicit:

```ts
const schema = {
  todo: {
    id: id("Todo"),
    title: NonEmptyString,
    dueDate: nullOr(NonEmptyString), // NULL until someone sets it
    priority: withDefault(0)(FiniteNumber), // backfilled to 0 on upgrade
  },
};
```

With `withDefault`, the engine adds the column as `NOT NULL DEFAULT …`, backfills
existing `NULL`s once, and rows inserted by older devices get the default too.
`withDefault` is TypeScript-only today: the Swift and Kotlin engines add every new
column as plain nullable, so handle `NULL` there.

## Renaming and removing

Two facts make removal unsafe: the engine never drops a column, and an edit's
payload carries every column the device has on disk. A build that stops
declaring `notes` still has the last value it saw in SQLite and still sends it
with every edit — so an older app that still uses `notes` gets its edits
reverted. Keep a retired column declared, stop writing it, and say so:

```ts
todo: {
  id: id("Todo"),
  title: NonEmptyString,
  body: nullOr(NonEmptyString),
  /** @deprecated Replaced by `body`. Still declared so older apps aren't reverted. */
  notes: nullOr(NonEmptyString),
},
```

Declared, the old column keeps receiving older apps' edits, so the value this
build sends back is current rather than stale.

A rename is a removal plus an addition, so treat it as one: add the new column,
write to it, and read both. Newer code prefers the new column and falls back to
the old one, which older apps keep writing:

```ts
const body = row.body ?? row.notes;
```

## Changing a column type

A value that fails the receiving build's column type is held, not applied, and
recorded as `applyFailed` in the sync log (`getSyncLog()`). Change `amount` from
`FiniteNumber` to `NonEmptyString`, and every edit from an older app is held on
newer devices for good. Add a new column with the new type instead, and read both
as above.

Relaxing a constraint — a longer `maxLength`, a wider range — works in one
direction only. Newer builds accept everything older ones wrote, but an older
build holds any newly allowed value it still rejects until it upgrades. Test
both directions before shipping it.

## When to bump `schemaVersion`

Additive changes — tables, columns, indexes — stay on `schemaVersion: 1`. Bump it
only when an existing field's **meaning** changes incompatibly: a price moves
from cents to dollars, a timestamp from local time to UTC. Older apps then hold
those events instead of reading dollars as cents, and apply them once they
upgrade to a build that declares the new version.

`schemaVersion` is engine-wide, though. After a bump, older apps hold **every**
change from upgraded devices, not just the field whose meaning moved — the whole
fleet stops converging until everyone upgrades. Adding a new column with the new
meaning almost always beats a bump.
