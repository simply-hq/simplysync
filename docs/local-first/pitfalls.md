# Common pitfalls

The mistakes that cost real debugging time, whichever client you build. Most
come from treating a synced table like an ordinary database; the rest are
platform setup.

## Every client

- **Forgetting to filter `isDeleted`.** Soft-deleted rows stay in the table.
  Add `.where("isDeleted", "=", 0)` in TypeScript, or `where "isDeleted" = 0` in
  Swift and Kotlin SQL, to every query that should hide them. The TypeScript
  engine warns when you don't — treat the warning as a bug report, not noise.
- **Hard-deleting rows.** Use `engine.delete` so the deletion replicates as a
  tombstone, can lose to a later edit, and reaches other devices. A hard
  `DELETE` through the driver resurrects the row on the next pull.
- **Expecting field-level merges.** Conflicts resolve row-level
  last-writer-wins; two offline edits to different fields of one row keep one
  row wholesale.
- **Treating the relay as authoritative.** It can withhold or reorder events
  (availability), but cannot read or forge payloads. Design for eventual
  consistency.
- **Renaming or removing a column after release.** Older apps keep writing the
  old column. Add a new column and read both instead — see
  [Schema evolution](./schema.md).

## React Native

- **Calling crypto before the native bootstrap loads.** Import
  `@simplysync/react-native/install` first in `index.js`, before Expo Router or
  any engine module, or engine boot throws "WebCrypto is required".

## Swift and Kotlin

- **Quote table names in SQL** (`from "entry"`) so the reactive cache can tell
  which writes refresh a query.
- **Keep column names lowercase-ASCII** so canonical-JSON ordering matches the
  other clients (see [parity rules](./native.md#parity-rules-what-must-stay-byte-identical)).
- **Swift: make row fields match what you insert.** A non-optional `Bool` field
  over a column you left `NULL` will fail to decode and the row is dropped —
  provide the value or make the field optional.
- **Android needs its own drivers.** Inject an `android.database`-backed
  `SqliteDriver` and a Keystore-backed `SecureStorage`; the bundled
  JDBC/in-memory ones are for JVM and tests.

---

**Next:** [Client API](./guide.md) · [Schema evolution](./schema.md) ·
[For agents](./agents.md) (the same mistakes as a fix-it table).
