# @simplysync/engine

A schema-driven, reactive, end-to-end-encrypted **local-first store** for
building personal apps — todo lists, chat, local-first AI chat, notes, trackers.
Apps write to a local SQLite database first; sync happens opportunistically
through a relay that only ever sees ciphertext.

> 📚 Background: **[User Guide](../../docs/local-first/guide.md)** ·
> **[Architecture](../../docs/local-first/architecture.md)** · crypto/wire core:
> **[@simplysync/protocol](../simplysync-protocol/README.md)**

- **Local-first & reactive.** Reads come from local SQLite and re-render the
  instant data changes; sync is in the background.
- **End-to-end encrypted.** Rows are AES-GCM encrypted on-device before they
  reach a relay (see the protocol package).
- **Conflict resolution is last-writer-wins by hybrid logical clock (HLC)** —
  per row, deterministic and convergent across devices.
- **Schema-driven & typed.** Declare tables with a small type DSL; queries are
  typed via Kysely.

## Use from source

Run `bun run clone core ../my-sync-core` from a full checkout, or choose a
client preset such as `react-native`, `web`, `cli`, or `node`; each includes the
engine and protocol source automatically. In the selected clone, run
`bun install --no-save && bun run build`.

The engine is platform-neutral: inject a SQLite driver and secure storage.
Browser apps use the `@simplysync/browser` workspace; native apps use their
platform adapter source.

## Quick start

```ts
import {
  createSync,
  id,
  NonEmptyString,
  SqliteBoolean,
  sqliteFalse,
} from "@simplysync/engine";

const schema = {
  todo: { id: id("Todo"), title: NonEmptyString, done: SqliteBoolean },
};

// Inject a platform SQLite driver + secure storage for the recovery key/phrase.
const engine = createSync({ createSqliteDriver, secureStorage })(schema, {
  name: "my-app",
  transports: [{ url: "https://relay.example" }], // optional
});
await engine.ready;

engine.insert("todo", { title: "Buy milk", done: sqliteFalse });

const activeTodos = engine.createQuery((db) =>
  db.selectFrom("todo").selectAll().where("isDeleted", "=", 0),
);
const rows = await engine.loadQuery(activeTodos); // or subscribe for reactivity
```

Every row automatically gets `createdAt`, `updatedAt` (the HLC), and `isDeleted`
(soft-delete flag) system columns. Queries should filter `where isDeleted = 0` —
`createQuery` warns once per query when they don't, since a missing filter
silently returns deleted rows. Pass `{ includeDeleted: true }` as the second
argument for a query that means to read tombstones.

## Writing data

| Method | Use |
| --- | --- |
| `insert(table, values, opts?)` | Create a row (auto-id if omitted). |
| `update(table, {id, ...}, opts?)` | Update an existing row. |
| `upsert(table, values, opts?)` | Insert or update. |
| `delete(table, id, opts?)` | **Soft-delete** — replicates as a tombstone; idempotent. |
| `deleteMany(table, ids, opts?)` | Soft-delete many in one atomic batch. |
| `batch(ops, opts?)` | Many writes (incl. `mode: "delete"`) in **one** transaction, **one** refresh, **one** sync — atomic. |

`MutationOptions`: `{ onComplete?, local? }`.

### Streaming writes for AI chat — `{ local: true }`

Streaming an AI reply token-by-token shouldn't push hundreds of soon-superseded
events. Write intermediate states locally, then commit once:

```ts
const reply = engine.insert("message", { role: "assistant", body: "" });
for await (const token of llmStream) {
  body += token;
  engine.update("message", { id: reply.value.id, body }, { local: true }); // no sync
}
engine.update("message", { id: reply.value.id, body }); // one synced event
```

`{ local: true }` writes to the local DB and refreshes queries (UI stays live)
but skips replication; the committing write wins LWW with a fresh HLC.

## Reorderable lists — fractional indexing

For drag-to-reorder todos or insert-between chat threads, store a string
ordering key and sort by it. Minting a key *between* two neighbours touches only
the moved row, so it merges cleanly under LWW (no renumbering).

```ts
import { keyBetween, keysBetween, FractionalIndex } from "@simplysync/engine";

// schema: { todo: { id: id("Todo"), title: NonEmptyString, order: FractionalIndex } }
const [a, b, c] = keysBetween(null, null, 3); // seed three spread keys
engine.insert("todo", { title: "First", order: a });
// move a row to the top:
engine.update("todo", { id, order: keyBetween(null, a) });
// query: .orderBy("order").orderBy("id")  // id tie-break = compareOrderKeys
```

## Conflict-free counters — reactions, votes, unread badges

A plain integer counter loses concurrent increments under LWW. Model each
increment as a delta row instead — `SUM(delta)` is conflict-free.

```ts
import { counterColumns, incrementCounter, counterTotalQuery } from "@simplysync/engine";

// schema: { reaction: counterColumns() }
incrementCounter(engine, "reaction", `${messageId}:thumbsup`);
const likes = await engine.loadQuery(
  counterTotalQuery(engine, "reaction", `${messageId}:thumbsup`), // reactive
);
```

## Text search

A composable, case-insensitive `LIKE` predicate (multi-term AND, multi-column
OR) that drops into your own typed query — wildcards in user input are escaped.

```ts
import { searchFilter } from "@simplysync/engine";

engine.createQuery((db) =>
  db.selectFrom("message").selectAll()
    .where("isDeleted", "=", 0)
    .where(searchFilter(["body", "author"], userInput)),
);
```

## Structured data — JSON columns

Store arrays/objects (todo tags & subtasks, AI content blocks & tool calls, chat
attachment metadata, settings) in a `JsonText` column. Encode on write, decode
safely on read.

```ts
import { JsonText, encodeJson, decodeJsonOr } from "@simplysync/engine";

// schema: { todo: { id: id("Todo"), title: NonEmptyString, tags: nullOr(JsonText) } }
engine.update("todo", { id, tags: encodeJson(["work", "urgent"]) });
const tags = decodeJsonOr<string[]>(row.tags, []); // never throws on bad data
```

## Presence — typing, online, "AI is thinking…"

Ephemeral real-time state that is **never persisted** and never touches the sync
log. Transport-agnostic: cross-tab via `BroadcastChannel` today, or any
WebSocket you own.

```ts
import { createPresenceChannel, createBroadcastChannelTransport } from "@simplysync/engine";

const typing = createPresenceChannel<boolean>("room:42:typing", {
  transport: createBroadcastChannelTransport("my-app"),
  selfId: myDeviceId,
});
typing.publish(true);            // re-publish ~every ttlMs/2 to stay present
typing.list();                   // live (non-expired) peers
typing.subscribe(() => render());
```

## Evolving your schema

Adding a column or a table to your schema is **automatic** — on open, the engine
runs additive migrations (`ALTER TABLE ADD COLUMN`, `CREATE TABLE`). Existing
rows read `NULL` for new columns until a write backfills them. Migrations are
additive only (no rename/drop) so older and newer app versions stay
wire-compatible against the same relay.

Leave `SyncEngineConfig.schemaVersion` at its default `1` for those additive
changes. If payload field meaning changes incompatibly, bump the version in the
new app. Older clients retain higher-version events in `_sync_deferred` instead
of partially applying them; startup replays them once an upgraded client
declares support.

## Storage hygiene (long-lived apps)

- **Synced tombstones are retained.** Until the protocol has a durable
  cross-device delete watermark, automatically hard-deleting an old tombstone
  could let a device that was offline past the retention window resurrect its
  stale row.
- **`engine.purgeDeleted({ olderThanMs? })`** — hard-delete old tombstones for a
  database that has never used a relay. It deliberately returns
  `{ purged: 0 }` after any relay history exists, even if transports are later
  detached.
- **`engine.purgeRows(rows)`** — immediate "Delete Permanently"/"Empty Trash":
  hard-delete specific tombstones in a never-synced database, skipping the age
  window. It has the same durable relay-history guard.
- **Outbox pruning is automatic** — after a successful sync, events confirmed
  delivered to every configured relay are dropped from the send queue, so the
  outbox doesn't grow without bound.

## Sync & identity

- **`transports`** is a list — configure **multiple relays** for redundancy;
  each receives a full copy of this device's writes.
- **`sync()`**, **`setTransports()`**, **`subscribeSyncState()`**,
  **`getSyncState()`**, **`getPendingOutboxCount()`**, **`getSyncLog()`** for
  control and diagnostics.
- **Identity**: a native `sf1_` key or BIP39 recovery phrase derives the owner deterministically;
  `restoreAppOwner`, `resetAppOwner`, and encrypted `exportDatabase` /
  `importDatabase` move data between devices.

## Reference implementations

Two end-to-end scenarios double as how-to guides and are exercised by the test
suite:

- **Todo app** — `test/todo-app.test.ts` (ordering, tags, complete, search,
  clear-completed).
- **Chat / AI-chat app** — `test/chat-app.test.ts` (ordered messages, streamed
  reply, reactions, structured content, search, edit, delete).

```sh
bun test            # from this package, or the repo root (runs the monorepo)
```
