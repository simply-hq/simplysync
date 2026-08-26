// The canonical SimplySync todo demo in a browser.
//
// Two engines ("Alice" and "Bob") share one owner and can sync through the
// source-owned Cloudflare relay. The schema is the same `todo(id, title, done)`
// contract used by the CLI, Swift, Kotlin, and React Native clients.
// Local SQLite (sql.js) remains the source of truth, writes are encrypted before
// they leave the device, and conflicts resolve last-write-wins by HLC.

import { StrictMode, useEffect, useId, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createSync,
  type AppOwner,
  type Query,
  type SyncEngine,
  type SyncState,
} from "@simplysync/engine";
import { SyncProvider, useQuery, useSync, useSyncState } from "@simplysync/react";
import {
  closeSqlJsDatabases,
  createBrowserOwnerStore,
  createEncryptedSecureStorage,
  createIndexedDbSnapshotStore,
  createSqlJsDriverFactory,
  deriveBrowserAppOwner,
  getActiveDb,
  persistNow,
  type BrowserOwnerStore,
  type IndexedDbSnapshotStore,
} from "@simplysync/browser";
import { DB_NAME, schema, type TodoSchema } from "./schema";
import { httpTransport, loadRelayUrl, saveRelayUrl } from "./relay";
import { readOutboxDiagnostics } from "./internals";
import { createTodoListQuery, type TodoRow } from "./todo-query";

type Engine = SyncEngine<TodoSchema>;
const RECOVERY_CONFIRMED_KEY = `${DB_NAME}:recoveryConfirmed`;

const DEVICES = [
  { name: `${DB_NAME}-alice`, label: "Alice" },
  { name: `${DB_NAME}-bob`, label: "Bob" },
] as const;

async function reloadApp(): Promise<void> {
  await persistNow();
  location.reload();
}

type Notify = (text: string | null) => void;

async function copyRecoveryKey(owner: AppOwner, setMessage: Notify, setError: Notify) {
  try {
    await navigator.clipboard.writeText(owner.recoveryKey);
    setMessage("Recovery key copied.");
    setError(null);
  } catch (caught) {
    setError(caught instanceof Error ? caught.message : String(caught));
  }
}

async function restoreOwner(
  ownerStore: BrowserOwnerStore,
  snapshots: IndexedDbSnapshotStore,
  credential: string,
  setError: Notify,
) {
  try {
    await ownerStore.setRecoveryKey(credential);
    await closeSqlJsDatabases();
    await snapshots.clear();
    location.reload();
  } catch (caught) {
    setError(caught instanceof Error ? caught.message : String(caught));
  }
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
    return [];
  }
}

function SyncBadge({ state, relayReady }: { state: SyncState; relayReady: boolean }) {
  if (!relayReady) {
    return <span className="pg-badge pg-badge-idle">Local only</span>;
  }
  const map: Record<SyncState["type"], { text: string; cls: string }> = {
    SyncStateInitial: { text: "Manual sync", cls: "pg-badge-idle" },
    SyncStateIsSyncing: { text: "Syncing…", cls: "pg-badge-sync" },
    SyncStateIsSynced: { text: "Manual sync", cls: "pg-badge-idle" },
    SyncStateIsNotSynced: { text: "Needs attention", cls: "pg-badge-err" },
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

function AddTodoForm({ engine, deviceLabel }: { engine: Engine; deviceLabel: string }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setError("Enter a todo.");
      return;
    }
    const result = engine.insert("todo", { title: trimmed, done: 0 });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setTitle("");
    setError(null);
  }

  return (
    <form className="pg-form" onSubmit={handleSubmit}>
      <input
        aria-label={`Todo title for ${deviceLabel}`}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={Boolean(error)}
        placeholder="What needs doing?"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <button type="submit" aria-label={`Add todo to ${deviceLabel}`}>Add</button>
      <p id={errorId} className="pg-error pg-form-error" role={error ? "alert" : undefined}>
        {error}
      </p>
    </form>
  );
}

function TodoItem({ engine, row }: { engine: Engine; row: TodoRow }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setTitle(row.title);
  }, [editing, row.title]);

  function toggle() {
    const result = engine.update("todo", {
      id: row.id,
      done: row.done ? 0 : 1,
    });
    if (!result.ok) setError(result.error.message);
  }

  function save() {
    const trimmed = title.trim();
    if (!trimmed) {
      setError("A todo needs a title.");
      return;
    }
    const result = engine.update("todo", { id: row.id, title: trimmed });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setEditing(false);
    setError(null);
  }

  function remove() {
    const result = engine.delete("todo", row.id);
    if (!result.ok) setError(result.error.message);
  }

  if (editing) {
    return (
      <li className="pg-list-edit">
        <input
          aria-label={`Edit ${row.title}`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
            if (event.key === "Escape") setEditing(false);
          }}
          autoFocus
        />
        <button onClick={save}>Save</button>
        <button className="pg-ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {error ? <p className="pg-error" role="alert">{error}</p> : null}
      </li>
    );
  }

  return (
    <li className="pg-todo">
      <label className="pg-todo-label">
        <input
          className="pg-check"
          type="checkbox"
          aria-label={`Mark ${row.title} ${row.done ? "incomplete" : "complete"}`}
          checked={row.done !== 0}
          onChange={toggle}
        />
        <span className={row.done ? "pg-todo-title pg-todo-done" : "pg-todo-title"}>
          {row.title}
        </span>
      </label>
      <button className="pg-ghost" aria-label={`Edit ${row.title}`} onClick={() => setEditing(true)}>
        Edit
      </button>
      <button className="pg-del" aria-label={`Delete ${row.title}`} onClick={remove}>
        ×
      </button>
      {error ? <p className="pg-error" role="alert">{error}</p> : null}
    </li>
  );
}

function Internals({ name }: { name: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 750);
    return () => clearInterval(timer);
  }, []);

  const meta = Object.fromEntries(
    rawSelect(name, `select key, value from "_sync_meta"`).map((row) => [
      row.key as string,
      row.value as string,
    ]),
  );
  const outbox = readOutboxDiagnostics((sql) => rawSelect(name, sql));
  const seen =
    (rawSelect(name, `select count(*) as c from "_sync_seen"`)[0]?.c as number) ?? 0;
  const cursors = Object.entries(meta).filter(([key]) => key.startsWith("cursor:"));
  const latest = outbox.recent[0]?.envelope_json as string | undefined;

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
      <summary>Inspect sync state</summary>
      <dl className="pg-stats">
        <div><dt>HLC time</dt><dd>{meta["hlc:time"] ?? "—"}</dd></div>
        <div><dt>HLC counter</dt><dd>{meta["hlc:counter"] ?? "—"}</dd></div>
        <div><dt>outbox pending</dt><dd>{outbox.pending}</dd></div>
        <div><dt>outbox total</dt><dd>{outbox.total}</dd></div>
        <div><dt>seen events</dt><dd>{seen}</dd></div>
        <div><dt>cursor</dt><dd>{cursors.map(([, value]) => value).join(", ") || "—"}</dd></div>
      </dl>
      <p className="pg-label">Recent events (latest 8; what the relay receives)</p>
      <table className="pg-events">
        <thead>
          <tr><th>eventId (HLC)</th><th>device</th><th>pushed</th></tr>
        </thead>
        <tbody>
          {outbox.recent.map((row) => {
            let device = "";
            try {
              device = (JSON.parse(row.envelope_json as string).deviceId as string) ?? "";
            } catch {
              device = "";
            }
            return (
              <tr key={row.event_id as string}>
                <td className="pg-mono">{(row.event_id as string).slice(0, 18)}…</td>
                <td className="pg-mono">{device}</td>
                <td>{row.pushed_at ? "✓" : "·"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="pg-label">Latest envelope — opaque to the relay</p>
      <pre className="pg-cipher">{cipher}</pre>
    </details>
  );
}

function DeviceBody({
  name,
  label,
  todosQuery,
  relayUrl,
}: {
  name: string;
  label: string;
  todosQuery: Query<TodoRow>;
  relayUrl: string;
}) {
  const engine = useSync<TodoSchema>();
  const todos = useQuery(todosQuery);
  const syncState = useSyncState();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const completed = todos.filter((todo) => todo.done !== 0).length;
  const relayReady = Boolean(relayUrl.trim());

  async function syncOnce() {
    if (!relayReady) {
      setSyncMessage("Connect a relay before syncing. Local edits still work.");
      return;
    }
    setSyncMessage(`Syncing ${label}…`);
    engine.setTransports(httpTransport(relayUrl));
    try {
      await engine.sync();
      setSyncMessage(`${label} finished syncing.`);
    } catch (caught) {
      setSyncMessage(
        `${label} could not sync: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    } finally {
      engine.setTransports([]);
    }
  }

  const titleId = `device-${label.toLowerCase()}-title`;

  return (
    <>
      <header className="pg-card-head">
        <div className="pg-device-title">
          <h2 id={titleId}>{label}</h2>
          <span className="pg-sub">Device · local SQLite</span>
          <SyncBadge state={syncState} relayReady={relayReady} />
        </div>
        <div className="pg-head-right">
          <span className="pg-count">{completed} of {todos.length} complete</span>
          <button
            className="pg-ghost"
            disabled={!relayReady || syncState.type === "SyncStateIsSyncing"}
            onClick={() => void syncOnce()}
          >
            Sync {label}
          </button>
        </div>
      </header>
      <AddTodoForm engine={engine} deviceLabel={label} />
      {todos.length === 0 ? (
        <p className="pg-empty">
          {label === "Bob"
            ? "Bob starts empty. Sync Alice, then Bob, to bring changes here."
            : "No todos yet. Add one here or load the example."}
        </p>
      ) : (
        <ul className="pg-list">
          {todos.map((todo) => (
            <TodoItem key={todo.id} engine={engine} row={todo} />
          ))}
        </ul>
      )}
      {syncMessage ? <p className="pg-sync-message" role="status">{syncMessage}</p> : null}
      <Internals name={name} />
    </>
  );
}

function TopBar({
  engines,
  owner,
  relayUrl,
  onRelayChange,
  ownerStore,
  snapshots,
}: {
  engines: readonly Engine[];
  owner: AppOwner;
  relayUrl: string;
  onRelayChange: (url: string) => void;
  ownerStore: BrowserOwnerStore;
  snapshots: IndexedDbSnapshotStore;
}) {
  const [relayDraft, setRelayDraft] = useState(relayUrl);
  const [credential, setCredential] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function applyRelay() {
    const trimmed = relayDraft.trim();
    if (trimmed) {
      try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      } catch {
        setError("Enter a complete http:// or https:// relay URL.");
        setMessage(null);
        return;
      }
    }
    saveRelayUrl(trimmed);
    onRelayChange(trimmed);
    setMessage(
      trimmed
        ? "Relay ready. This demo syncs only when you use a device's Sync button."
        : "Local-only mode. Alice and Bob will not exchange changes.",
    );
    setError(null);
  }

  function seed() {
    const existing = rawSelect(
      DEVICES[0].name,
      `select count(*) as count from "todo" where "isDeleted" = 0`,
    );
    if (Number(existing[0]?.count ?? 0) > 0) {
      setMessage("Alice already has todos. The example was not added again.");
      setError(null);
      return;
    }
    const result = engines[0]?.batch(
      ["Buy milk", "Walk the dog", "Write the report"].map((title) => ({
        table: "todo" as const,
        values: { title, done: 0 },
      })),
    );
    if (!result) {
      setError("Alice's local database is still starting. Try again in a moment.");
      return;
    }
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setMessage("Three todos added on Alice. Sync to send them to Bob.");
    setError(null);
  }

  async function reset() {
    if (!confirm("Reset to a brand-new owner? This wipes both local devices.")) return;
    await closeSqlJsDatabases();
    await snapshots.clear();
    await ownerStore.rotateRecoveryKey();
    location.reload();
  }

  return (
    <section className="pg-topbar" aria-label="Demo setup">
      <div className="pg-runbook">
        <div className="pg-runbook-head">
          <div>
            <h2>Try the sync loop</h2>
            <p>This demo pauses background sync so each hop stays visible.</p>
          </div>
          <button className="pg-ghost" onClick={seed}>Load example on Alice</button>
        </div>
        <ol className="pg-steps">
          <li><span><strong>Change Alice.</strong> Add, edit, or complete a todo.</span></li>
          <li><span><strong>Sync Alice.</strong> Encrypted changes go to the relay.</span></li>
          <li><span><strong>Sync Bob.</strong> Bob pulls them into its own SQLite.</span></li>
        </ol>
      </div>

      <div className="pg-controls">
        <label className="pg-field">
          <span>Relay URL</span>
          <span className="pg-inline">
            <input
              aria-label="Relay URL"
              placeholder="https://your-relay.workers.dev"
              value={relayDraft}
              onChange={(event) => setRelayDraft(event.target.value)}
            />
            <button onClick={applyRelay}>Use relay</button>
          </span>
        </label>
        <p className="pg-hint">
          Required to move changes between Alice and Bob. Need one?{" "}
          <a href="https://simplysync.org/self-hosting">Deploy a relay</a>.
        </p>
        {message ? <p className="pg-hint" role="status">{message}</p> : null}
        {error ? <p className="pg-error" role="alert">{error}</p> : null}
      </div>

      <details className="pg-owner-settings">
        <summary>Owner &amp; recovery</summary>
        <div className="pg-owner-settings-body">
          <div>
            <p className="pg-owner-id"><strong>Owner ID</strong> <code>{owner.id}</code></p>
            <h3>Add another device</h3>
            <p className="pg-hint">Restore this recovery key on the other device.</p>
            <p className="pg-mnemonic">{owner.recoveryKey}</p>
            <p className="pg-warning">If you lose this key, no one can recover your synced data.</p>
            <button
              className="pg-ghost"
              onClick={() => void copyRecoveryKey(owner, setMessage, setError)}
            >
              Copy recovery key
            </button>
          </div>
          <div>
            <h3>Restore another owner</h3>
            <p className="pg-hint">This replaces both local demo devices.</p>
            <textarea
              aria-label="Recovery key or phrase"
              placeholder="paste an sf1_ key or legacy recovery phrase"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              rows={3}
            />
            <button
              disabled={!credential.trim()}
              onClick={() => void restoreOwner(ownerStore, snapshots, credential, setError)}
            >
              Restore owner
            </button>
            <button className="pg-danger" onClick={() => void reset()}>
              Reset owner
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}

function RecoverySetup({
  owner,
  ownerStore,
  snapshots,
  onComplete,
}: {
  owner: AppOwner;
  ownerStore: BrowserOwnerStore;
  snapshots: IndexedDbSnapshotStore;
  onComplete: () => void;
}) {
  const [credential, setCredential] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="pg-onboarding">
      <p className="pg-onboarding-kicker">Before you start</p>
      <h1>Keep your recovery key</h1>
      <p className="pg-onboarding-copy">
        Save it if you want to restore this owner elsewhere or add another
        device. You can continue without copying it for this disposable demo.
      </p>
      <p className="pg-mnemonic">{owner.recoveryKey}</p>
      <p className="pg-warning">
        If you lose this key, no one can recover your synced data.
      </p>
      <div className="pg-actions">
        <button
          className="pg-ghost"
          onClick={() => void copyRecoveryKey(owner, setMessage, setError)}
        >
          Copy recovery key
        </button>
        <button
          onClick={() => {
            localStorage.setItem(RECOVERY_CONFIRMED_KEY, owner.id);
            onComplete();
          }}
        >
          Continue to demo
        </button>
      </div>
      {message ? <p className="pg-hint" role="status">{message}</p> : null}

      <details className="pg-restore pg-onboarding-restore">
        <summary>Already have a recovery key?</summary>
        <textarea
          aria-label="Existing recovery key or phrase"
          placeholder="paste an sf1_ key or 24-word recovery phrase"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          rows={3}
        />
        <button
          disabled={!credential.trim()}
          onClick={() => void restoreOwner(ownerStore, snapshots, credential, setError)}
        >
          Restore this owner
        </button>
      </details>
      {error ? <p className="pg-error" role="alert">{error}</p> : null}
    </main>
  );
}

function App({
  engines,
  owner,
  todosQuery,
  initialRelayUrl,
  ownerStore,
  snapshots,
}: {
  engines: readonly Engine[];
  owner: AppOwner;
  todosQuery: Query<TodoRow>;
  initialRelayUrl: string;
  ownerStore: BrowserOwnerStore;
  snapshots: IndexedDbSnapshotStore;
}) {
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(
    () => localStorage.getItem(RECOVERY_CONFIRMED_KEY) === owner.id,
  );
  const [relayUrl, setRelayUrl] = useState(initialRelayUrl);

  if (!recoveryConfirmed) {
    return (
      <RecoverySetup
        onComplete={() => setRecoveryConfirmed(true)}
        owner={owner}
        ownerStore={ownerStore}
        snapshots={snapshots}
      />
    );
  }

  return (
    <>
      <header className="pg-header">
        <h1>Watch two local databases converge</h1>
        <p>
          Alice and Bob are separate SQLite databases in this browser. Change one,
          sync each device, and compare. The relay receives ciphertext—not todo text.
        </p>
      </header>
      <TopBar
        engines={engines}
        owner={owner}
        relayUrl={relayUrl}
        onRelayChange={setRelayUrl}
        ownerStore={ownerStore}
        snapshots={snapshots}
      />
      <main className="pg-grid" aria-label="Synced todo devices">
        {DEVICES.map((device, index) => (
          <section
            key={device.name}
            className="pg-card pg-device"
            aria-labelledby={`device-${device.label.toLowerCase()}-title`}
          >
            <SyncProvider value={engines[index]}>
              <DeviceBody
                name={device.name}
                label={device.label}
                todosQuery={todosQuery}
                relayUrl={relayUrl}
              />
            </SyncProvider>
          </section>
        ))}
      </main>
    </>
  );
}

async function bootstrap(): Promise<void> {
  const secureStorage = createEncryptedSecureStorage({
    databaseName: DB_NAME,
  });
  const ownerStore = createBrowserOwnerStore(secureStorage, {
    key: `${DB_NAME}:recoveryKey`,
  });
  const owner = await deriveBrowserAppOwner(
    await ownerStore.loadOrCreateRecoveryKey(),
  );
  const relayUrl = loadRelayUrl();
  const snapshots = createIndexedDbSnapshotStore({
    databaseName: DB_NAME,
  });
  const createSqliteDriver = createSqlJsDriverFactory({
    store: snapshots,
    locateFile: () => "sql-wasm.wasm",
  });

  const make = (name: string): Engine =>
    createSync({ createSqliteDriver, secureStorage, reloadApp })(
      schema,
      {
        name,
        externalAppOwner: owner,
        transports: [],
        syncIntervalMs: 600_000,
      },
    );
  const engines: Engine[] = DEVICES.map((device) => make(device.name));
  const todos = createTodoListQuery(engines[0]);

  window.addEventListener("pagehide", () => void persistNow());

  const root = document.getElementById("app");
  if (root) {
    createRoot(root).render(
      <StrictMode>
        <App
          engines={engines}
          owner={owner}
          todosQuery={todos}
          initialRelayUrl={relayUrl}
          ownerStore={ownerStore}
          snapshots={snapshots}
        />
      </StrictMode>,
    );
  }
}

void bootstrap();
