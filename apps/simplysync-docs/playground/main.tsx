// The SimplySync browser playground. Everything here runs on-device: a local
// SQLite database (sql.js) is the source of truth, the engine encrypts each
// write into an opaque envelope, and the UI shows your plaintext data next to
// the ciphertext a relay would store. No relay is configured, so nothing leaves
// the page — this is purely a "see the guarantees for yourself" demo.

import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createSync,
  sqliteTrue,
  type AppOwner,
  type Query,
  type SyncEngine,
} from "@simplysync/engine";
import { SyncProvider, createUseSync, useQuery } from "@simplysync/react";
import { DB_NAME, schema, type PlaygroundSchema } from "./schema";
import * as idb from "./idb";
import {
  createSqlJsDriverFactory,
  getActiveDb,
  persistNow,
} from "./sql-driver";

// --- Engine wiring ---------------------------------------------------------

const localStorageSecureStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
  removeItem: (key: string) => localStorage.removeItem(key),
};

// Flush the snapshot BEFORE reloading so reset/restore (which wipe then reload)
// can't lose the wipe to the debounce window — the reloaded page would otherwise
// rehydrate stale data from IndexedDB.
async function reloadApp(): Promise<void> {
  await persistNow();
  location.reload();
}

const engine: SyncEngine<PlaygroundSchema> = createSync({
  createSqliteDriver: createSqlJsDriverFactory({
    store: { load: idb.load, save: idb.save },
    locateFile: () => "sql-wasm.wasm",
  }),
  secureStorage: localStorageSecureStorage,
  reloadApp,
})(schema, { name: DB_NAME });

// Best-effort flush if the tab is closed between debounced saves.
window.addEventListener("pagehide", () => void persistNow());

const useMutations = createUseSync(engine);

type EntryRow = {
  id: string;
  description: string;
  amountCents: number;
  createdAt: string;
};

const entriesQuery: Query<EntryRow> = engine.createQuery((db) =>
  db
    .selectFrom("entry")
    .select(["id", "description", "amountCents", "createdAt"])
    .where("isDeleted", "=", 0)
    .orderBy("createdAt", "desc"),
);

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

/** Reads the engine-internal outbox directly — this is exactly the ciphertext a
 * relay would receive. Returns newest-first. */
function readOutboxEnvelopes(limit: number): string[] {
  const db = getActiveDb();
  if (!db) return [];
  try {
    const stmt = db.prepare(
      `select envelope_json from "_sync_outbox" order by event_id desc limit ${limit}`,
    );
    try {
      const out: string[] = [];
      while (stmt.step()) {
        out.push(stmt.getAsObject().envelope_json as string);
      }
      return out;
    } finally {
      stmt.free();
    }
  } catch {
    return []; // table not created yet (pre-init)
  }
}

// --- Components ------------------------------------------------------------

function AddEntryForm() {
  const { insert } = useMutations();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const cents = parseDollarsToCents(amount);
    if (!description.trim() || cents === null) {
      setError("Enter a description and a dollar amount (e.g. -4.50).");
      return;
    }
    const result = insert("entry", { description: description.trim(), amountCents: cents });
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
        placeholder="Description (e.g. Coffee)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <input
        aria-label="Amount in dollars"
        placeholder="Amount (e.g. -4.50)"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button type="submit">Add</button>
      {error ? <p className="pg-error">{error}</p> : null}
    </form>
  );
}

function EntriesPanel() {
  const { update } = useMutations();
  const entries = useQuery(entriesQuery);
  const balance = useMemo(
    () => entries.reduce((sum, row) => sum + row.amountCents, 0),
    [entries],
  );

  return (
    <section className="pg-card">
      <header className="pg-card-head">
        <h2>Your data <span className="pg-sub">local SQLite · source of truth</span></h2>
        <p className="pg-balance">{formatCents(balance)}</p>
      </header>
      <AddEntryForm />
      {entries.length === 0 ? (
        <p className="pg-empty">No entries yet. Add one above, or seed a few.</p>
      ) : (
        <ul className="pg-list">
          {entries.map((row) => (
            <li key={row.id}>
              <span className="pg-desc">{row.description}</span>
              <span className={row.amountCents < 0 ? "pg-neg" : "pg-pos"}>
                {formatCents(row.amountCents)}
              </span>
              <button
                className="pg-del"
                aria-label={`Delete ${row.description}`}
                onClick={() => update("entry", { id: row.id, isDeleted: sqliteTrue })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RelayViewPanel() {
  const entries = useQuery(entriesQuery); // re-render trigger on each write
  const [envelopes, setEnvelopes] = useState<string[]>([]);

  // Poll the outbox: the envelope is written asynchronously after AES-GCM
  // encryption, so a light poll is simpler/robuster than racing the mutation.
  useEffect(() => {
    const tick = () => setEnvelopes(readOutboxEnvelopes(5));
    tick();
    const timer = setInterval(tick, 750);
    return () => clearInterval(timer);
  }, [entries.length]);

  const latest = envelopes[0];
  let pretty = "Ciphertext appears here after your first write.";
  if (latest) {
    try {
      pretty = JSON.stringify(JSON.parse(latest), null, 2);
    } catch {
      pretty = latest;
    }
  }

  return (
    <section className="pg-card">
      <header className="pg-card-head">
        <h2>What the relay sees <span className="pg-sub">opaque · undecryptable</span></h2>
        <p className="pg-count">{envelopes.length} envelope(s) queued</p>
      </header>
      <pre className="pg-cipher">{pretty}</pre>
      <p className="pg-note">
        The relay only ever stores <code>nonce + ciphertext</code> plus routing
        metadata. The <code>table</code>, amounts, and descriptions are inside the
        AES-256-GCM ciphertext — the key never leaves this page.
      </p>
    </section>
  );
}

function OwnerPanel() {
  const { resetAppOwner, restoreAppOwner } = useMutations();
  const [owner, setOwner] = useState<AppOwner | null>(null);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void engine.appOwner.then((value) => {
      if (active) setOwner(value);
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleRestore() {
    setBusy(true);
    setError(null);
    try {
      // force: true — with no relay configured there's no backup to verify
      // against, so we switch to this owner on this device intentionally.
      await restoreAppOwner(phrase.trim(), { force: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  function handleSeed() {
    const { insert } = engine;
    insert("entry", { description: "Groceries", amountCents: -5231 });
    insert("entry", { description: "Paycheck", amountCents: 250000 });
    insert("entry", { description: "Coffee", amountCents: -450 });
  }

  return (
    <section className="pg-card pg-owner">
      <h2>Your owner <span className="pg-sub">derived on-device</span></h2>
      {owner ? (
        <>
          <p className="pg-owner-id">
            <strong>ownerId:</strong> <code>{owner.id}</code>
          </p>
          <p className="pg-label">recovery phrase (your only credential)</p>
          <p className="pg-mnemonic">{owner.mnemonic}</p>
        </>
      ) : (
        <p className="pg-empty">Deriving identity…</p>
      )}

      <div className="pg-actions">
        <button onClick={handleSeed}>Seed sample data</button>
        <button
          className="pg-danger"
          onClick={() => {
            if (confirm("Reset to a brand-new owner? This wipes local data."))
              void resetAppOwner();
          }}
        >
          Reset owner
        </button>
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
        <button disabled={busy || !phrase.trim()} onClick={() => void handleRestore()}>
          {busy ? "Restoring…" : "Restore (switch owner)"}
        </button>
        {error ? <p className="pg-error">{error}</p> : null}
      </details>
    </section>
  );
}

function App() {
  return (
    <SyncProvider value={engine}>
      <header className="pg-header">
        <h1>SimplySync Playground</h1>
        <p>
          A local-first, end-to-end-encrypted ledger running entirely in your
          browser. Edit on the left; watch the encrypted envelope a relay would
          store on the right.
        </p>
      </header>
      <main className="pg-grid">
        <EntriesPanel />
        <RelayViewPanel />
        <OwnerPanel />
      </main>
    </SyncProvider>
  );
}

const root = document.getElementById("app");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
