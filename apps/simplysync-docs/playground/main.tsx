// The SimplySync browser playground — a comprehensive, two-device demo.
//
// Two engines ("Alice" and "Bob") share one owner and sync through a relay you
// run locally (`bun run relay:bun`). Everything runs on-device: local SQLite
// (sql.js) is the source of truth, the engine encrypts each write into an opaque
// envelope, and the relay only ever moves ciphertext. Edit on one device, sync,
// and watch the other converge — including last-writer-wins on conflicts. The
// internals inspector exposes the outbox, cursor, HLC clock, and event log.

import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createSync,
  sqliteTrue,
  type AppOwner,
  type Query,
  type SyncEngine,
  type SyncState,
} from "@simplysync/engine";
import { SyncProvider, useQuery, useSync, useSyncState } from "@simplysync/react";
import { DB_NAME, schema, type PlaygroundSchema } from "./schema";
import * as idb from "./idb";
import {
  createSqlJsDriverFactory,
  getActiveDb,
  persistNow,
} from "./sql-driver";
import { deriveAppOwner, loadOrCreateMnemonic, rotateMnemonic, setMnemonic } from "./owner";
import { httpTransport, loadRelayUrl, saveRelayUrl } from "./relay";

type Engine = SyncEngine<PlaygroundSchema>;

const DEVICES = [
  { name: `${DB_NAME}-alice`, label: "Alice" },
  { name: `${DB_NAME}-bob`, label: "Bob" },
] as const;

const localStorageSecureStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
  removeItem: (key: string) => localStorage.removeItem(key),
};

async function reloadApp(): Promise<void> {
  await persistNow();
  location.reload();
}

// --- Row + query types -----------------------------------------------------

type EntryRow = {
  id: string;
  description: string;
  amountCents: number;
  createdAt: string;
  categoryId: string | null;
  categoryName: string | null;
};
type CategoryRow = { id: string; name: string };

// Built once from one engine — the compiled SQL is identical for both, and the
// leftJoin returns the category name as a flat column (no JSON parsing).
function buildQueries(engine: Engine) {
  const entries: Query<EntryRow> = engine.createQuery((db) =>
    db
      .selectFrom("entry")
      .leftJoin("category", "category.id", "entry.categoryId")
      .select([
        "entry.id as id",
        "entry.description as description",
        "entry.amountCents as amountCents",
        "entry.createdAt as createdAt",
        "entry.categoryId as categoryId",
        "category.name as categoryName",
      ])
      .where("entry.isDeleted", "=", 0)
      .orderBy("entry.createdAt", "desc"),
  );
  const categories: Query<CategoryRow> = engine.createQuery((db) =>
    db
      .selectFrom("category")
      .select(["id", "name"])
      .where("isDeleted", "=", 0)
      .orderBy("name", "asc"),
  );
  return { entries, categories };
}

// --- Helpers ---------------------------------------------------------------

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function parseDollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

function rawSelect(dbName: string, sql: string): Record<string, unknown>[] {
  const db = getActiveDb(dbName);
  if (!db) return [];
  try {
    const stmt = db.prepare(sql);
    try {
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  } catch {
    return []; // tables not created yet (pre-init)
  }
}

// --- Components -------------------------------------------------------------

function SyncBadge({ state }: { state: SyncState }) {
  const map: Record<SyncState["type"], { text: string; cls: string }> = {
    SyncStateInitial: { text: "idle", cls: "pg-badge-idle" },
    SyncStateIsSyncing: { text: "syncing…", cls: "pg-badge-sync" },
    SyncStateIsSynced: { text: "synced", cls: "pg-badge-ok" },
    SyncStateIsNotSynced: { text: "not synced", cls: "pg-badge-err" },
  };
  const info = map[state.type];
  return (
    <span
      className={`pg-badge ${info.cls}`}
      title={state.type === "SyncStateIsNotSynced" ? state.error : undefined}
    >
      {info.text}
    </span>
  );
}

function AddEntryForm({
  engine,
  categories,
}: {
  engine: Engine;
  categories: readonly CategoryRow[];
}) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const cents = parseDollarsToCents(amount);
    if (!description.trim() || cents === null) {
      setError("Enter a description and a dollar amount (e.g. -4.50).");
      return;
    }
    const result = engine.insert("entry", {
      description: description.trim(),
      amountCents: cents,
      categoryId: categoryId || null,
    });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setDescription("");
    setAmount("");
    setError(null);
  }

  return (
    <form className="pg-form" onSubmit={handleSubmit}>
      <input
        aria-label="Description"
        placeholder="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <input
        aria-label="Amount in dollars"
        placeholder="-4.50"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <select
        aria-label="Category"
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
      >
        <option value="">no category</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button type="submit">Add</button>
      {error ? <p className="pg-error">{error}</p> : null}
    </form>
  );
}

function EntryItem({
  engine,
  row,
  categories,
}: {
  engine: Engine;
  row: EntryRow;
  categories: readonly CategoryRow[];
}) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(row.description);
  const [amount, setAmount] = useState((row.amountCents / 100).toString());
  const [categoryId, setCategoryId] = useState(row.categoryId ?? "");

  function save() {
    const cents = parseDollarsToCents(amount);
    if (!description.trim() || cents === null) return;
    engine.update("entry", {
      id: row.id,
      description: description.trim(),
      amountCents: cents,
      categoryId: categoryId || null,
    });
    setEditing(false);
  }

  if (editing) {
    return (
      <li className="pg-list-edit">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">no category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button onClick={save}>Save</button>
        <button className="pg-ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </li>
    );
  }

  return (
    <li>
      <span className="pg-desc">
        {row.description}
        {row.categoryName ? <span className="pg-chip">{row.categoryName}</span> : null}
      </span>
      <span className={row.amountCents < 0 ? "pg-neg" : "pg-pos"}>
        {formatCents(row.amountCents)}
      </span>
      <button className="pg-ghost" aria-label="Edit" onClick={() => setEditing(true)}>
        ✎
      </button>
      <button
        className="pg-del"
        aria-label={`Delete ${row.description}`}
        onClick={() => engine.update("entry", { id: row.id, isDeleted: sqliteTrue })}
      >
        ×
      </button>
    </li>
  );
}

function Internals({ name }: { name: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 750);
    return () => clearInterval(t);
  }, []);

  const meta = Object.fromEntries(
    rawSelect(name, `select key, value from "_sync_meta"`).map((r) => [
      r.key as string,
      r.value as string,
    ]),
  );
  const outbox = rawSelect(
    name,
    `select event_id, envelope_json, pushed_at from "_sync_outbox" order by event_id desc limit 8`,
  );
  const pending = outbox.filter((r) => r.pushed_at === null).length;
  const seen =
    (rawSelect(name, `select count(*) as c from "_sync_seen"`)[0]?.c as number) ?? 0;
  const cursors = Object.entries(meta).filter(([k]) => k.startsWith("cursor:"));
  const latest = outbox[0]?.envelope_json as string | undefined;

  let cipher = "Ciphertext appears after the first write.";
  if (latest) {
    try {
      cipher = JSON.stringify(JSON.parse(latest), null, 2);
    } catch {
      cipher = latest;
    }
  }

  return (
    <details className="pg-internals">
      <summary>Sync internals</summary>
      <dl className="pg-stats">
        <div><dt>HLC time</dt><dd>{meta["hlc:time"] ?? "—"}</dd></div>
        <div><dt>HLC counter</dt><dd>{meta["hlc:counter"] ?? "—"}</dd></div>
        <div><dt>outbox pending</dt><dd>{pending}</dd></div>
        <div><dt>outbox total</dt><dd>{outbox.length}</dd></div>
        <div><dt>seen events</dt><dd>{seen}</dd></div>
        <div><dt>cursor</dt><dd>{cursors.map(([, v]) => v).join(", ") || "—"}</dd></div>
      </dl>
      <p className="pg-label">recent events (what the relay receives)</p>
      <table className="pg-events">
        <thead>
          <tr><th>eventId (HLC)</th><th>device</th><th>pushed</th></tr>
        </thead>
        <tbody>
          {outbox.map((r) => {
            let device = "";
            try {
              device = (JSON.parse(r.envelope_json as string).deviceId as string) ?? "";
            } catch {
              device = "";
            }
            return (
              <tr key={r.event_id as string}>
                <td className="pg-mono">{(r.event_id as string).slice(0, 18)}…</td>
                <td className="pg-mono">{device}</td>
                <td>{r.pushed_at ? "✓" : "·"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="pg-label">latest envelope — opaque, undecryptable</p>
      <pre className="pg-cipher">{cipher}</pre>
    </details>
  );
}

function DeviceBody({
  name,
  label,
  queries,
}: {
  name: string;
  label: string;
  queries: { entries: Query<EntryRow>; categories: Query<CategoryRow> };
}) {
  const engine = useSync<PlaygroundSchema>();
  const entries = useQuery(queries.entries);
  const categories = useQuery(queries.categories);
  const syncState = useSyncState();
  const balance = useMemo(
    () => entries.reduce((sum, row) => sum + row.amountCents, 0),
    [entries],
  );

  return (
    <>
      <header className="pg-card-head">
        <h2>
          {label} <span className="pg-sub">device</span> <SyncBadge state={syncState} />
        </h2>
        <div className="pg-head-right">
          <span className="pg-balance">{formatCents(balance)}</span>
          <button className="pg-ghost" onClick={() => void engine.sync()}>
            Sync now
          </button>
        </div>
      </header>
      <AddEntryForm engine={engine} categories={categories} />
      {entries.length === 0 ? (
        <p className="pg-empty">No entries. Add one, or seed from the top bar.</p>
      ) : (
        <ul className="pg-list">
          {entries.map((row) => (
            <EntryItem key={row.id} engine={engine} row={row} categories={categories} />
          ))}
        </ul>
      )}
      <Internals name={name} />
    </>
  );
}

function DeviceColumn({
  engine,
  name,
  label,
  queries,
}: {
  engine: Engine;
  name: string;
  label: string;
  queries: { entries: Query<EntryRow>; categories: Query<CategoryRow> };
}) {
  return (
    <section className="pg-card pg-device">
      <SyncProvider value={engine}>
        <DeviceBody name={name} label={label} queries={queries} />
      </SyncProvider>
    </section>
  );
}

function TopBar({
  engines,
  owner,
  initialRelayUrl,
}: {
  engines: readonly Engine[];
  owner: AppOwner;
  initialRelayUrl: string;
}) {
  const [relayUrl, setRelayUrl] = useState(initialRelayUrl);
  const [categoryName, setCategoryName] = useState("");
  const [phrase, setPhrase] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);

  function applyRelay() {
    saveRelayUrl(relayUrl);
    for (const engine of engines) engine.setTransports(httpTransport(relayUrl));
  }

  function addCategory() {
    if (!categoryName.trim()) return;
    engines[0].insert("category", { name: categoryName.trim() });
    setCategoryName("");
  }

  async function reset() {
    if (!confirm("Reset to a brand-new owner? This wipes both devices.")) return;
    rotateMnemonic();
    await idb.clear();
    location.reload();
  }

  async function restore() {
    try {
      setMnemonic(phrase);
      await idb.clear();
      location.reload();
    } catch (caught) {
      setRestoreError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="pg-card pg-topbar">
      <div className="pg-owner-block">
        <p className="pg-owner-id"><strong>ownerId:</strong> <code>{owner.id}</code></p>
        <p className="pg-label">shared recovery phrase (both devices)</p>
        <p className="pg-mnemonic">{owner.mnemonic}</p>
      </div>

      <div className="pg-controls">
        <label className="pg-field">
          <span>Relay URL</span>
          <span className="pg-inline">
            <input value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} />
            <button onClick={applyRelay}>Connect</button>
          </span>
        </label>
        <p className="pg-hint">
          Run a relay with <code>bun run relay:bun</code>, then Connect. Without
          one, edits stay local (local-first) and sync shows “not synced”.
        </p>

        <label className="pg-field">
          <span>Add category</span>
          <span className="pg-inline">
            <input
              value={categoryName}
              placeholder="e.g. Food"
              onChange={(e) => setCategoryName(e.target.value)}
            />
            <button onClick={addCategory}>Add</button>
          </span>
        </label>

        <div className="pg-actions">
          <button className="pg-danger" onClick={() => void reset()}>Reset owner</button>
        </div>

        <details className="pg-restore">
          <summary>Restore from a recovery phrase</summary>
          <textarea
            aria-label="Recovery phrase"
            placeholder="paste a 24-word recovery phrase"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            rows={3}
          />
          <button disabled={!phrase.trim()} onClick={() => void restore()}>
            Restore (switch owner)
          </button>
          {restoreError ? <p className="pg-error">{restoreError}</p> : null}
        </details>
      </div>
    </section>
  );
}

function App({
  engines,
  owner,
  queries,
  initialRelayUrl,
}: {
  engines: readonly Engine[];
  owner: AppOwner;
  queries: { entries: Query<EntryRow>; categories: Query<CategoryRow> };
  initialRelayUrl: string;
}) {
  return (
    <>
      <header className="pg-header">
        <h1>SimplySync Playground</h1>
        <p>
          Two devices, one owner, syncing through a relay — entirely in your
          browser. Edit on one side, hit “Sync now” (with a relay running), and
          watch the other converge. Conflicting edits resolve last-writer-wins.
        </p>
      </header>
      <TopBar engines={engines} owner={owner} initialRelayUrl={initialRelayUrl} />
      <main className="pg-grid">
        {DEVICES.map((device, i) => (
          <DeviceColumn
            key={device.name}
            engine={engines[i]}
            name={device.name}
            label={device.label}
            queries={queries}
          />
        ))}
      </main>
    </>
  );
}

// --- Bootstrap -------------------------------------------------------------

async function bootstrap(): Promise<void> {
  const owner = await deriveAppOwner(loadOrCreateMnemonic());
  const relayUrl = loadRelayUrl();
  const createSqliteDriver = createSqlJsDriverFactory({
    store: { load: idb.load, save: idb.save },
    locateFile: () => "sql-wasm.wasm",
  });

  const make = (name: string): Engine =>
    createSync({ createSqliteDriver, secureStorage: localStorageSecureStorage, reloadApp })(
      schema,
      {
        name,
        externalAppOwner: owner,
        transports: httpTransport(relayUrl),
        syncIntervalMs: 2000,
      },
    );
  const engines: Engine[] = DEVICES.map((device) => make(device.name));

  const queries = buildQueries(engines[0]);

  window.addEventListener("pagehide", () => void persistNow());

  const root = document.getElementById("app");
  if (root) {
    createRoot(root).render(
      <StrictMode>
        <App engines={engines} owner={owner} queries={queries} initialRelayUrl={relayUrl} />
      </StrictMode>,
    );
  }
}

void bootstrap();
