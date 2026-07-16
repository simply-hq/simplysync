import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  createSync,
  counterColumns,
  FractionalIndex,
  id,
  JsonText,
  keyBetween,
  NonEmptyString,
  nullOr,
  searchFilter,
  String as Str,
  type AppOwner,
  type SecureStorage,
  type SqliteDriver,
  type SyncEngine,
} from "@simplysync/engine";

// A local-first AI-chat schema. Messages are kept in a stable order via a
// fractional index (so threaded inserts and reorders merge cleanly), `body`
// holds the (streamed) text, and `content` optionally holds structured blocks
// (tool calls, attachments) as JSON. Reactions use the conflict-free counter.
export const schema = {
  message: {
    id: id("Message"),
    role: NonEmptyString, // "user" | "assistant"
    body: Str,
    order: FractionalIndex,
    content: nullOr(JsonText),
  },
  reaction: counterColumns(),
};

export type ChatEngine = SyncEngine<typeof schema>;

function ensureDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

// A synchronous SQLite driver over bun:sqlite (the shape the engine expects).
function bunDriver(path: string): SqliteDriver {
  if (path !== ":memory:") ensureDir(path);
  const db = new Database(path);
  return {
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
}

// A tiny JSON-file secure storage so the recovery phrase + device id persist
// across runs (a real app would use the OS keychain / expo-secure-store).
function fileSecureStorage(path: string): SecureStorage {
  ensureDir(path);
  const read = (): Record<string, string> =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const write = (data: Record<string, string>) =>
    writeFileSync(path, JSON.stringify(data, null, 2));
  return {
    getItem: (k) => read()[k] ?? null,
    setItem: (k, v) => {
      const data = read();
      data[k] = v;
      write(data);
    },
    removeItem: (k) => {
      const data = read();
      delete data[k];
      write(data);
    },
  };
}

export interface ChatEngineOptions {
  /** Database path; `:memory:` for an ephemeral session. Default `./data/ai-chat.db`. */
  dbPath?: string;
  /** Optional relay URLs for cross-device sync. */
  relayUrls?: readonly string[];
  /** Override fetch (e.g. an in-process fake relay for demos/tests). */
  fetch?: typeof fetch;
  /** Adopt an existing owner (share one recovery phrase across devices). */
  externalAppOwner?: AppOwner | null;
  /** Override secure storage (e.g. in-memory for a second simulated device). */
  secureStorage?: SecureStorage;
}

export function createChatEngine(opts: ChatEngineOptions = {}): ChatEngine {
  const dbPath = opts.dbPath ?? "./data/ai-chat.db";
  const secretsPath =
    dbPath === ":memory:" ? "./data/ai-chat.secrets.json" : `${dbPath}.secrets.json`;
  return createSync({
    createSqliteDriver: () => bunDriver(dbPath),
    secureStorage: opts.secureStorage ?? fileSecureStorage(secretsPath),
    fetch: opts.fetch,
  })(schema, {
    name: "ai-chat",
    transports: (opts.relayUrls ?? []).map((url) => ({ type: "Http", url })),
    externalAppOwner: opts.externalAppOwner ?? null,
  });
}

export interface MessageRow {
  id: string;
  role: string;
  body: string;
  order: string;
  content: string | null;
}

const transcriptQuery = (engine: ChatEngine) =>
  engine.createQuery((db) =>
    db
      .selectFrom("message")
      .select(["id", "role", "body", "order", "content"])
      .where("isDeleted", "=", 0)
      .orderBy("order")
      .orderBy("id"),
  );

/** The ordered, non-deleted transcript. */
export async function transcript(engine: ChatEngine): Promise<MessageRow[]> {
  return [...(await engine.loadQuery(transcriptQuery(engine)))] as MessageRow[];
}

/** Mint an ordering key that appends after the last message. */
export async function nextOrder(engine: ChatEngine): Promise<string> {
  const rows = await transcript(engine);
  const last = rows.length ? rows[rows.length - 1]!.order : null;
  return keyBetween(last, null);
}

/** Search the transcript (case-insensitive, multi-term) over message bodies. */
export async function searchMessages(
  engine: ChatEngine,
  query: string,
): Promise<MessageRow[]> {
  const rows = await engine.loadQuery(
    engine.createQuery((db) =>
      db
        .selectFrom("message")
        .select(["id", "role", "body", "order", "content"])
        .where("isDeleted", "=", 0)
        .where(searchFilter(["body"], query))
        .orderBy("order")
        .orderBy("id"),
    ),
  );
  return [...rows] as MessageRow[];
}
