import * as SQLite from "expo-sqlite";
import * as SecureStore from "expo-secure-store";

import {
  compareHlc,
  createDeviceId,
  createHlc,
  createRecoveryKey,
  decryptEnvelope,
  deriveIdentity,
  encryptPayload,
  normalizeRecoveryKey,
  type LocalFirstIdentity,
  type SyncEnvelope,
  type SyncPayload,
} from "@simplysync/core";

export interface FinanceEntry {
  readonly id: string;
  readonly description: string;
  readonly amountCents: number;
  readonly updatedAtHlc: string;
  readonly deletedAtHlc: string | null;
}

export interface SyncSummary {
  readonly pushed: number;
  readonly duplicates: number;
  readonly pulled: number;
  readonly applied: number;
  readonly cursor: string;
}

export interface EntryPageCursor {
  readonly updatedAtHlc: string;
  readonly id: string;
}

export interface EntryPage {
  readonly entries: FinanceEntry[];
  readonly nextCursor: EntryPageCursor | null;
  readonly hasMore: boolean;
}

interface ClientOptions {
  readonly relayUrl: string;
}

interface PullResponse {
  readonly events: SyncEnvelope[];
  readonly nextCursor: string;
}

interface PushResponse {
  readonly accepted: number;
  readonly duplicate: number;
}

interface EntryRow {
  readonly id: string;
  readonly description: string;
  readonly amount_cents: number;
  readonly updated_at_hlc: string;
  readonly deleted_at_hlc: string | null;
}

const DATABASE_NAME = "local-first-finance-demo.db";
const SECURE_RECOVERY_KEY = "simplysync.localFirstDemo.recoveryKey";
const SECURE_DEVICE_ID = "simplysync.localFirstDemo.deviceId";
const SECURE_DATABASE_KEY = "simplysync.localFirstDemo.databaseKey";
const META_HLC_TIME = "hlcTime";
const META_HLC_COUNTER = "hlcCounter";
const META_CURSOR_PREFIX = "cursor:";
const META_LAST_ENVELOPE = "lastEnvelopeJson";
const ENTRY_PAGE_SIZE = 100;
const MAX_ENTRY_PAGE_SIZE = 250;
const PUSH_BATCH_SIZE = 500;
const PULL_BATCH_SIZE = 1_000;

export { DATABASE_NAME };

export class ExpoLocalFirstClient {
  private identity: LocalFirstIdentity | null = null;
  private deviceId: string | null = null;
  private relayUrl: string;

  private constructor(
    private readonly db: SQLite.SQLiteDatabase,
    options: ClientOptions,
  ) {
    this.relayUrl = normalizeRelayUrl(options.relayUrl);
  }

  static async open(options: ClientOptions): Promise<ExpoLocalFirstClient> {
    const db = await SQLite.openDatabaseAsync(DATABASE_NAME, {
      enableChangeListener: true,
    });
    await applyDatabaseKey(db);
    await migrate(db);

    const client = new ExpoLocalFirstClient(db, options);
    await client.boot();
    return client;
  }

  get ownerId(): string {
    return this.requireIdentity().ownerId;
  }

  get recoveryKey(): string {
    return this.requireIdentity().recoveryKey;
  }

  get localDeviceId(): string {
    if (!this.deviceId) throw new Error("Client has not booted.");
    return this.deviceId;
  }

  get currentRelayUrl(): string {
    return this.relayUrl;
  }

  setRelayUrl(relayUrl: string): void {
    this.relayUrl = normalizeRelayUrl(relayUrl);
  }

  async close(): Promise<void> {
    await this.db.closeAsync();
  }

  async addEntry(description: string, amountCents: number): Promise<FinanceEntry> {
    const hlc = await this.nextHlc();
    const id = `${this.localDeviceId}-${hlc}`;
    const entry: FinanceEntry = {
      id,
      description,
      amountCents,
      updatedAtHlc: hlc,
      deletedAtHlc: null,
    };

    await this.upsertEntry(entry);
    await this.enqueue("upsert", id, hlc, entry);
    return entry;
  }

  async deleteEntry(id: string): Promise<void> {
    const existing = await this.getEntry(id);
    if (!existing) throw new Error(`No entry found for ${id}.`);

    const hlc = await this.nextHlc();
    const entry: FinanceEntry = {
      ...existing,
      updatedAtHlc: hlc,
      deletedAtHlc: hlc,
    };

    await this.upsertEntry(entry);
    await this.enqueue("delete", id, hlc, { id, deletedAtHlc: hlc });
  }

  async getEntryPage(options?: {
    readonly cursor?: EntryPageCursor | null;
    readonly includeDeleted?: boolean;
    readonly limit?: number;
  }): Promise<EntryPage> {
    const limit = clampPageSize(options?.limit ?? ENTRY_PAGE_SIZE);
    const params: (number | string)[] = [];
    const where: string[] = [];

    if (!options?.includeDeleted) {
      where.push("deleted_at_hlc is null");
    }

    if (options?.cursor) {
      where.push("(updated_at_hlc < ? or (updated_at_hlc = ? and id < ?))");
      params.push(
        options.cursor.updatedAtHlc,
        options.cursor.updatedAtHlc,
        options.cursor.id,
      );
    }

    params.push(limit + 1);

    const rows = await this.db.getAllAsync<EntryRow>(
      `select id, description, amount_cents, updated_at_hlc, deleted_at_hlc
       from entries
       ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
       order by updated_at_hlc desc, id desc
       limit ?`,
      ...params,
    );
    const visibleRows = rows.slice(0, limit);
    const entries = visibleRows.map(mapEntryRow);
    const lastEntry = entries.at(-1);

    return {
      entries,
      nextCursor: lastEntry
        ? { updatedAtHlc: lastEntry.updatedAtHlc, id: lastEntry.id }
        : null,
      hasMore: rows.length > limit,
    };
  }

  async getEntryCount(): Promise<number> {
    return (
      (
        await this.db.getFirstAsync<{ count: number }>(
          `select count(*) as count from entries where deleted_at_hlc is null`,
        )
      )?.count ?? 0
    );
  }

  async getBalanceCents(): Promise<number> {
    return (
      (
        await this.db.getFirstAsync<{ balance_cents: number | null }>(
          `select coalesce(sum(amount_cents), 0) as balance_cents
           from entries
           where deleted_at_hlc is null`,
        )
      )?.balance_cents ?? 0
    );
  }

  async sync(): Promise<SyncSummary> {
    const pushResult = await this.pushOutbox();
    const pullResult = await this.pullAndApply();
    return {
      pushed: pushResult.accepted,
      duplicates: pushResult.duplicate,
      pulled: pullResult.pulled,
      applied: pullResult.applied,
      cursor: pullResult.cursor,
    };
  }

  async getStoredEnvelopeJson(): Promise<string | null> {
    return (
      (
        await this.db.getFirstAsync<{ envelope_json: string }>(
          `select value as envelope_json
           from meta
           where key = ?`,
          META_LAST_ENVELOPE,
        )
      )?.envelope_json ?? null
    );
  }

  async resetOwnerAndLocalData(): Promise<void> {
    await this.clearLocalData();
    await SecureStore.deleteItemAsync(SECURE_RECOVERY_KEY);
    await SecureStore.deleteItemAsync(SECURE_DEVICE_ID);
    await this.boot();
  }

  async restoreFromRecoveryKey(recoveryKey: string): Promise<void> {
    const normalizedRecoveryKey = normalizeRecoveryKey(recoveryKey);
    const restoredIdentity = await deriveIdentity(normalizedRecoveryKey);
    const nextDeviceId = await createDeviceId();

    await this.clearLocalData();
    await SecureStore.setItemAsync(SECURE_RECOVERY_KEY, normalizedRecoveryKey);
    await SecureStore.setItemAsync(SECURE_DEVICE_ID, nextDeviceId);

    this.identity = restoredIdentity;
    this.deviceId = nextDeviceId;
  }

  private async boot(): Promise<void> {
    const recoveryKey = await getOrCreateSecureValue(
      SECURE_RECOVERY_KEY,
      createRecoveryKey,
    );
    const deviceId = await getOrCreateSecureValue(
      SECURE_DEVICE_ID,
      createDeviceId,
    );

    this.identity = await deriveIdentity(recoveryKey);
    this.deviceId = deviceId;
  }

  private async enqueue(
    op: SyncPayload["op"],
    rowId: string,
    hlc: string,
    value: unknown,
  ): Promise<void> {
    const envelope = await encryptPayload(
      this.requireIdentity(),
      {
        eventId: hlc,
        deviceId: this.localDeviceId,
      },
      {
        schemaVersion: 1,
        table: "entries",
        op,
        rowId,
        hlc,
        value,
      },
    );

    await this.db.runAsync(
      `insert into sync_outbox (event_id, envelope_json)
       values (?, ?)`,
      envelope.eventId,
      JSON.stringify(envelope),
    );
    await this.setMeta(META_LAST_ENVELOPE, JSON.stringify(envelope));
    await this.markSeen(envelope.eventId);
  }

  private async pushOutbox(): Promise<PushResponse> {
    const identity = this.requireIdentity();
    let accepted = 0;
    let duplicate = 0;

    while (true) {
      const events = await this.db.getAllAsync<{
        readonly event_id: string;
        readonly envelope_json: string;
      }>(
        `select event_id, envelope_json
         from sync_outbox
         where pushed_at is null
         order by event_id asc
         limit ?`,
        PUSH_BATCH_SIZE,
      );

      if (events.length === 0) break;

      const response = await fetch(`${this.relayUrl}/v1/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${identity.relayAuth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ownerId: identity.ownerId,
          events: events.map((event) => JSON.parse(event.envelope_json)),
        }),
      });

      if (!response.ok) {
        throw new Error(`Relay push failed: ${response.status} ${await response.text()}`);
      }

      const body = (await response.json()) as PushResponse;
      accepted += body.accepted;
      duplicate += body.duplicate;

      await this.deleteOutboxBatch(events.map((event) => event.event_id));
      await yieldToRuntime();
    }

    return { accepted, duplicate };
  }

  private async pullAndApply(): Promise<{
    readonly pulled: number;
    readonly applied: number;
    readonly cursor: string;
  }> {
    const identity = this.requireIdentity();
    const cursorKey = `${META_CURSOR_PREFIX}${this.relayUrl}`;
    let cursor = (await this.getMeta(cursorKey)) ?? "";
    let pulled = 0;
    let applied = 0;

    while (true) {
      const url = `${this.relayUrl}/v1/events?ownerId=${encodeURIComponent(
        identity.ownerId,
      )}&after=${encodeURIComponent(cursor)}&limit=${PULL_BATCH_SIZE}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${identity.relayAuth}`,
        },
      });

      if (response.status === 404) {
        return {
          pulled,
          applied,
          cursor,
        };
      }

      if (!response.ok) {
        throw new Error(`Relay pull failed: ${response.status} ${await response.text()}`);
      }

      const body = (await response.json()) as PullResponse;
      if (body.events.length === 0 || body.nextCursor === cursor) break;

      pulled += body.events.length;
      applied += await this.decryptAndApplyEvents(identity, body.events);
      cursor = body.nextCursor;
      await this.setMeta(cursorKey, cursor);

      if (body.events.length < PULL_BATCH_SIZE) break;
      await yieldToRuntime();
    }

    return {
      pulled,
      applied,
      cursor,
    };
  }

  private async decryptAndApplyEvents(
    identity: LocalFirstIdentity,
    envelopes: readonly SyncEnvelope[],
  ): Promise<number> {
    const nextPayloads: {
      readonly eventId: string;
      readonly payload: SyncPayload;
    }[] = [];

    for (const envelope of envelopes) {
      if (await this.hasSeen(envelope.eventId)) {
        continue;
      }

      nextPayloads.push({
        eventId: envelope.eventId,
        payload: await decryptEnvelope(identity, envelope),
      });
    }

    if (nextPayloads.length === 0) return 0;

    await this.db.execAsync("begin");
    try {
      for (const nextPayload of nextPayloads) {
        await this.applyPayload(nextPayload.payload);
        await this.markSeen(nextPayload.eventId);
      }
      await this.db.execAsync("commit");
    } catch (error) {
      await this.db.execAsync("rollback");
      throw error;
    }

    return nextPayloads.length;
  }

  private async applyPayload(payload: SyncPayload): Promise<void> {
    if (payload.schemaVersion !== 1 || payload.table !== "entries") {
      throw new Error("Unsupported payload.");
    }

    const existing = await this.getEntry(payload.rowId);

    if (payload.op === "delete") {
      if (existing && compareHlc(existing.updatedAtHlc, payload.hlc) > 0) {
        return;
      }

      const deletedAtHlc =
        typeof payload.value === "object" &&
        payload.value !== null &&
        "deletedAtHlc" in payload.value &&
        typeof payload.value.deletedAtHlc === "string"
          ? payload.value.deletedAtHlc
          : payload.hlc;

      await this.upsertEntry({
        id: payload.rowId,
        description: existing?.description ?? "",
        amountCents: existing?.amountCents ?? 0,
        updatedAtHlc: payload.hlc,
        deletedAtHlc,
      });
      return;
    }

    const entry = payload.value as FinanceEntry;
    if (existing && compareHlc(existing.updatedAtHlc, entry.updatedAtHlc) >= 0) {
      return;
    }

    await this.upsertEntry(entry);
  }

  private async upsertEntry(entry: FinanceEntry): Promise<void> {
    await this.db.runAsync(
      `insert into entries
        (id, description, amount_cents, updated_at_hlc, deleted_at_hlc)
       values (?, ?, ?, ?, ?)
       on conflict(id) do update set
        description = excluded.description,
        amount_cents = excluded.amount_cents,
        updated_at_hlc = excluded.updated_at_hlc,
        deleted_at_hlc = excluded.deleted_at_hlc`,
      entry.id,
      entry.description,
      entry.amountCents,
      entry.updatedAtHlc,
      entry.deletedAtHlc,
    );
  }

  private async getEntry(id: string): Promise<FinanceEntry | null> {
    const row = await this.db.getFirstAsync<EntryRow>(
      `select id, description, amount_cents, updated_at_hlc, deleted_at_hlc
       from entries
       where id = ?`,
      id,
    );

    return row ? mapEntryRow(row) : null;
  }

  private async getMeta(key: string): Promise<string | null> {
    return (
      (
        await this.db.getFirstAsync<{ value: string }>(
          `select value from meta where key = ?`,
          key,
        )
      )?.value ?? null
    );
  }

  private async setMeta(key: string, value: string): Promise<void> {
    await this.db.runAsync(
      `insert into meta (key, value)
       values (?, ?)
       on conflict(key) do update set value = excluded.value`,
      key,
      value,
    );
  }

  private async markSeen(eventId: string): Promise<void> {
    await this.db.runAsync(
      `insert or ignore into sync_seen (event_id, seen_at)
       values (?, ?)`,
      eventId,
      new Date().toISOString(),
    );
  }

  private async hasSeen(eventId: string): Promise<boolean> {
    const row = await this.db.getFirstAsync<{ event_id: string }>(
      `select event_id from sync_seen where event_id = ?`,
      eventId,
    );
    return Boolean(row);
  }

  private async deleteOutboxBatch(eventIds: readonly string[]): Promise<void> {
    await this.db.execAsync("begin");
    try {
      for (const eventId of eventIds) {
        await this.db.runAsync(
          `delete from sync_outbox where event_id = ?`,
          eventId,
        );
      }
      await this.db.execAsync("commit");
    } catch (error) {
      await this.db.execAsync("rollback");
      throw error;
    }
  }

  private async nextHlc(): Promise<string> {
    const now = Date.now();
    const lastTime = Number((await this.getMeta(META_HLC_TIME)) ?? 0);
    const lastCounter = Number((await this.getMeta(META_HLC_COUNTER)) ?? 0);
    const nextTime = Math.max(now, lastTime);
    const nextCounter = nextTime === lastTime ? lastCounter + 1 : 0;

    await this.setMeta(META_HLC_TIME, String(nextTime));
    await this.setMeta(META_HLC_COUNTER, String(nextCounter));

    return createHlc(this.localDeviceId, nextTime, nextCounter);
  }

  private requireIdentity(): LocalFirstIdentity {
    if (!this.identity) throw new Error("Client has not booted.");
    return this.identity;
  }

  private async clearLocalData(): Promise<void> {
    await this.db.execAsync(`
      delete from entries;
      delete from sync_outbox;
      delete from sync_seen;
      delete from meta;
    `);
  }
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    pragma journal_mode = WAL;

    create table if not exists meta (
      key text primary key,
      value text not null
    );

    create table if not exists entries (
      id text primary key,
      description text not null,
      amount_cents integer not null,
      updated_at_hlc text not null,
      deleted_at_hlc text
    );

    create table if not exists sync_outbox (
      event_id text primary key,
      envelope_json text not null,
      pushed_at text
    );

    create table if not exists sync_seen (
      event_id text primary key,
      seen_at text not null
    );

    create index if not exists entries_active_updated_id
      on entries (deleted_at_hlc, updated_at_hlc desc, id desc);

    create index if not exists sync_outbox_pending_event_id
      on sync_outbox (pushed_at, event_id);
  `);
}

async function applyDatabaseKey(db: SQLite.SQLiteDatabase): Promise<void> {
  const databaseKey = await getOrCreateSecureValue(
    SECURE_DATABASE_KEY,
    createRecoveryKey,
  );
  await db.execAsync(`pragma key = '${escapeSqlString(databaseKey)}';`);
}

async function getOrCreateSecureValue(
  key: string,
  createValue: () => Promise<string>,
): Promise<string> {
  const stored = await SecureStore.getItemAsync(key);
  if (stored) return stored;

  const nextValue = await createValue();
  await SecureStore.setItemAsync(key, nextValue);
  return nextValue;
}

function mapEntryRow(row: EntryRow): FinanceEntry {
  return {
    id: row.id,
    description: row.description,
    amountCents: row.amount_cents,
    updatedAtHlc: row.updated_at_hlc,
    deletedAtHlc: row.deleted_at_hlc,
  };
}

function normalizeRelayUrl(relayUrl: string): string {
  const normalized = relayUrl.trim().replace(/\/$/u, "");
  if (!normalized) {
    throw new Error("Relay URL is required.");
  }
  return normalized;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function clampPageSize(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return ENTRY_PAGE_SIZE;
  return Math.min(Math.floor(limit), MAX_ENTRY_PAGE_SIZE);
}

function yieldToRuntime(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
