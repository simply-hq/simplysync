import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  compareHlc,
  createDeviceId,
  createHlc,
  createRecoveryKey,
  decryptBlob,
  decryptEnvelope,
  deriveIdentity,
  encryptBlob,
  encryptPayload,
  type BlobManifest,
  type LocalFirstIdentity,
  type SyncEnvelope,
  type SyncPayload,
} from "@simplysync/core";

export interface ExampleNote {
  readonly id: string;
  readonly body: string;
  readonly amountCents: number;
  readonly updatedAtHlc: string;
  readonly deletedAtHlc: string | null;
}

interface ClientOptions {
  readonly name: string;
  readonly relayUrl: string;
  readonly recoveryKey?: string;
}

interface PullResponse {
  readonly events: SyncEnvelope[];
  readonly nextCursor: string;
}

interface PushResponse {
  readonly accepted: number;
  readonly duplicate: number;
}

const META_RECOVERY_KEY = "recoveryKey";
const META_DEVICE_ID = "deviceId";
const META_HLC_TIME = "hlcTime";
const META_HLC_COUNTER = "hlcCounter";
const META_CURSOR_PREFIX = "cursor:";

export class LocalFirstClient {
  readonly name: string;
  readonly relayUrl: string;
  readonly db: Database;

  private identity: LocalFirstIdentity | null = null;
  private deviceId: string | null = null;

  private constructor(options: ClientOptions) {
    mkdirSync("data", { recursive: true });
    this.name = options.name;
    this.relayUrl = options.relayUrl.replace(/\/$/u, "");
    this.db = new Database(join("data", `${options.name}.db`));
    this.migrate();
  }

  static async open(options: ClientOptions): Promise<LocalFirstClient> {
    const client = new LocalFirstClient(options);
    await client.boot(options.recoveryKey);
    return client;
  }

  get ownerId(): string {
    return this.requireIdentity().ownerId;
  }

  get recoveryKey(): string {
    return this.requireIdentity().recoveryKey;
  }

  get relayAuth(): string {
    return this.requireIdentity().relayAuth;
  }

  get localDeviceId(): string {
    if (!this.deviceId) throw new Error("Client has not booted.");
    return this.deviceId;
  }

  async addNote(body: string, amountCents: number): Promise<ExampleNote> {
    const hlc = this.nextHlc();
    const id = `${this.localDeviceId}-${hlc}`;
    const note: ExampleNote = {
      id,
      body,
      amountCents,
      updatedAtHlc: hlc,
      deletedAtHlc: null,
    };

    this.upsertNote(note);
    await this.enqueue("notes", "upsert", id, hlc, note);
    return note;
  }

  async updateNote(id: string, patch: { body?: string; amountCents?: number }): Promise<void> {
    const existing = this.getNote(id);
    if (!existing) throw new Error(`No note found for ${id}.`);

    const hlc = this.nextHlc();
    const note: ExampleNote = {
      ...existing,
      body: patch.body ?? existing.body,
      amountCents: patch.amountCents ?? existing.amountCents,
      updatedAtHlc: hlc,
    };

    this.upsertNote(note);
    await this.enqueue("notes", "upsert", id, hlc, note);
  }

  async deleteNote(id: string): Promise<void> {
    const existing = this.getNote(id);
    if (!existing) throw new Error(`No note found for ${id}.`);

    const hlc = this.nextHlc();
    const note: ExampleNote = {
      ...existing,
      updatedAtHlc: hlc,
      deletedAtHlc: hlc,
    };

    this.upsertNote(note);
    await this.enqueue("notes", "delete", id, hlc, { id, deletedAtHlc: hlc });
  }

  /**
   * Stores a binary blob (e.g. an image): encrypts + chunks it, uploads the
   * chunk bytes to the relay (skipping any it already has), and enqueues a
   * small manifest as a sync event so other devices learn the blob exists.
   * Returns the manifest. Chunks are cached locally for instant re-reads.
   */
  async putBlob(data: Uint8Array, mimeType: string): Promise<BlobManifest> {
    const identity = this.requireIdentity();
    const { manifest, chunks } = await encryptBlob(identity, data, { mimeType });

    for (const chunk of chunks) {
      this.cacheChunk(chunk.hash, chunk.bytes);
      if (!(await this.relayHasBlob(chunk.hash))) {
        await this.uploadBlobChunk(chunk.hash, chunk.bytes);
      }
    }

    const hlc = this.nextHlc();
    this.storeManifestRow(manifest, hlc, null);
    await this.enqueue("blob", "upsert", manifest.blobId, hlc, manifest);
    return manifest;
  }

  /**
   * Lazily reads a blob: loads its (already-synced) manifest, fetches any chunk
   * bytes not in the local cache, verifies + decrypts, and returns the bytes.
   */
  async getBlob(blobId: string): Promise<{ mimeType: string; data: Uint8Array }> {
    const identity = this.requireIdentity();
    const manifest = this.getBlobManifest(blobId);
    if (!manifest) {
      throw new Error(`No blob manifest for ${blobId}. Sync first.`);
    }

    const storedChunks: Uint8Array[] = [];
    for (const ref of manifest.chunks) {
      let bytes = this.getCachedChunk(ref.hash);
      if (!bytes) {
        bytes = await this.downloadBlobChunk(ref.hash);
        this.cacheChunk(ref.hash, bytes);
      }
      storedChunks.push(bytes);
    }

    const data = await decryptBlob(identity, manifest, storedChunks);
    return { mimeType: manifest.mimeType, data };
  }

  getBlobManifest(blobId: string): BlobManifest | null {
    const row = this.db
      .query<{ manifest_json: string; deleted_at_hlc: string | null }, [string]>(
        `select manifest_json, deleted_at_hlc from blob_manifest where blob_id = ?`,
      )
      .get(blobId);
    if (!row || row.deleted_at_hlc) return null;
    return JSON.parse(row.manifest_json) as BlobManifest;
  }

  listNotes(options?: { includeDeleted?: boolean }): ExampleNote[] {
    const rows = this.db
      .query<{
        id: string;
        body: string;
        amount_cents: number;
        updated_at_hlc: string;
        deleted_at_hlc: string | null;
      }, []>(
        `select id, body, amount_cents, updated_at_hlc, deleted_at_hlc
         from notes
         ${options?.includeDeleted ? "" : "where deleted_at_hlc is null"}
         order by updated_at_hlc desc`,
      )
      .all();

    return rows.map((row) => ({
      id: row.id,
      body: row.body,
      amountCents: row.amount_cents,
      updatedAtHlc: row.updated_at_hlc,
      deletedAtHlc: row.deleted_at_hlc,
    }));
  }

  async sync(): Promise<{
    readonly pushed: number;
    readonly duplicates: number;
    readonly pulled: number;
    readonly applied: number;
    readonly cursor: string;
  }> {
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

  getStoredEnvelopeJson(): string[] {
    return this.db
      .query<{ envelope_json: string }, []>(
        `select envelope_json from sync_outbox order by event_id asc`,
      )
      .all()
      .map((row) => row.envelope_json);
  }

  private async boot(recoveryKey?: string): Promise<void> {
    const storedRecoveryKey = this.getMeta(META_RECOVERY_KEY);
    const nextRecoveryKey =
      recoveryKey ?? storedRecoveryKey ?? (await createRecoveryKey());

    if (storedRecoveryKey && recoveryKey && storedRecoveryKey !== recoveryKey) {
      throw new Error(
        `Client ${this.name} already has a different recovery key. Run clean or use another client name.`,
      );
    }

    this.setMeta(META_RECOVERY_KEY, nextRecoveryKey);

    const storedDeviceId = this.getMeta(META_DEVICE_ID);
    const nextDeviceId = storedDeviceId ?? (await createDeviceId());
    this.setMeta(META_DEVICE_ID, nextDeviceId);

    this.identity = await deriveIdentity(nextRecoveryKey);
    this.deviceId = nextDeviceId;
  }

  private migrate(): void {
    this.db.exec(`
      pragma journal_mode = WAL;

      create table if not exists meta (
        key text primary key,
        value text not null
      );

      create table if not exists notes (
        id text primary key,
        body text not null,
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

      create table if not exists blob_manifest (
        blob_id text primary key,
        manifest_json text not null,
        updated_at_hlc text not null,
        deleted_at_hlc text
      );

      create table if not exists blob_chunk (
        hash text primary key,
        bytes blob not null
      );
    `);
  }

  private async enqueue(
    table: string,
    op: SyncPayload["op"],
    rowId: string,
    hlc: string,
    value: unknown,
  ): Promise<void> {
    const identity = this.requireIdentity();
    const eventId = hlc;
    const envelope = await encryptPayload(
      identity,
      {
        eventId,
        deviceId: this.localDeviceId,
      },
      {
        schemaVersion: 1,
        table,
        op,
        rowId,
        hlc,
        value,
      },
    );

    this.db
      .prepare(
        `insert into sync_outbox (event_id, envelope_json)
         values (?, ?)`,
      )
      .run(eventId, JSON.stringify(envelope));
    this.markSeen(eventId);
  }

  private async pushOutbox(): Promise<PushResponse> {
    const identity = this.requireIdentity();
    const events = this.db
      .query<{ event_id: string; envelope_json: string }, []>(
        `select event_id, envelope_json
         from sync_outbox
         where pushed_at is null
         order by event_id asc`,
      )
      .all();

    if (events.length === 0) {
      return { accepted: 0, duplicate: 0 };
    }

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
    const pushedAt = new Date().toISOString();
    const markPushed = this.db.prepare(
      `update sync_outbox set pushed_at = ? where event_id = ?`,
    );

    for (const event of events) {
      markPushed.run(pushedAt, event.event_id);
    }

    return body;
  }

  private async pullAndApply(): Promise<{
    readonly pulled: number;
    readonly applied: number;
    readonly cursor: string;
  }> {
    const identity = this.requireIdentity();
    const cursorKey = `${META_CURSOR_PREFIX}${this.relayUrl}`;
    const after = this.getMeta(cursorKey) ?? "";
    const url = new URL(`${this.relayUrl}/v1/events`);
    url.searchParams.set("ownerId", identity.ownerId);
    url.searchParams.set("after", after);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${identity.relayAuth}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Relay pull failed: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as PullResponse;
    let applied = 0;

    for (const envelope of body.events) {
      if (this.hasSeen(envelope.eventId)) {
        continue;
      }

      const payload = await decryptEnvelope(identity, envelope);
      this.applyPayload(payload);
      this.markSeen(envelope.eventId);
      applied += 1;
    }

    this.setMeta(cursorKey, body.nextCursor);
    return {
      pulled: body.events.length,
      applied,
      cursor: body.nextCursor,
    };
  }

  private applyPayload(payload: SyncPayload): void {
    if (payload.schemaVersion !== 1) {
      throw new Error("Unsupported payload.");
    }
    if (payload.table === "notes") return this.applyNotePayload(payload);
    if (payload.table === "blob") return this.applyBlobPayload(payload);
    throw new Error(`Unsupported table: ${payload.table}`);
  }

  private applyNotePayload(payload: SyncPayload): void {
    const existing = this.getNote(payload.rowId);

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

      this.upsertNote({
        id: payload.rowId,
        body: existing?.body ?? "",
        amountCents: existing?.amountCents ?? 0,
        updatedAtHlc: payload.hlc,
        deletedAtHlc,
      });
      return;
    }

    const note = payload.value as ExampleNote;
    if (existing && compareHlc(existing.updatedAtHlc, note.updatedAtHlc) >= 0) {
      return;
    }

    this.upsertNote(note);
  }

  private applyBlobPayload(payload: SyncPayload): void {
    const currentHlc = this.getManifestHlc(payload.rowId);
    if (currentHlc && compareHlc(currentHlc, payload.hlc) >= 0) {
      return; // we already have this or a newer manifest
    }

    if (payload.op === "delete") {
      const existing = this.getBlobManifest(payload.rowId);
      if (existing) this.storeManifestRow(existing, payload.hlc, payload.hlc);
      return;
    }

    // Lazy: store the manifest only. Chunk bytes are fetched on first read.
    this.storeManifestRow(payload.value as BlobManifest, payload.hlc, null);
  }

  private storeManifestRow(
    manifest: BlobManifest,
    hlc: string,
    deletedAtHlc: string | null,
  ): void {
    this.db
      .prepare(
        `insert into blob_manifest (blob_id, manifest_json, updated_at_hlc, deleted_at_hlc)
         values (?, ?, ?, ?)
         on conflict(blob_id) do update set
          manifest_json = excluded.manifest_json,
          updated_at_hlc = excluded.updated_at_hlc,
          deleted_at_hlc = excluded.deleted_at_hlc`,
      )
      .run(manifest.blobId, JSON.stringify(manifest), hlc, deletedAtHlc);
  }

  private getManifestHlc(blobId: string): string | null {
    return (
      this.db
        .query<{ updated_at_hlc: string }, [string]>(
          `select updated_at_hlc from blob_manifest where blob_id = ?`,
        )
        .get(blobId)?.updated_at_hlc ?? null
    );
  }

  private cacheChunk(hash: string, bytes: Uint8Array): void {
    this.db
      .prepare(`insert or ignore into blob_chunk (hash, bytes) values (?, ?)`)
      .run(hash, bytes);
  }

  private getCachedChunk(hash: string): Uint8Array | null {
    const row = this.db
      .query<{ bytes: Uint8Array }, [string]>(
        `select bytes from blob_chunk where hash = ?`,
      )
      .get(hash);
    return row ? new Uint8Array(row.bytes) : null;
  }

  private blobUrl(hash: string): URL {
    const url = new URL(
      `${this.relayUrl}/v1/blobs/${encodeURIComponent(hash)}`,
    );
    url.searchParams.set("ownerId", this.requireIdentity().ownerId);
    return url;
  }

  private async relayHasBlob(hash: string): Promise<boolean> {
    const response = await fetch(this.blobUrl(hash), {
      method: "HEAD",
      headers: { Authorization: `Bearer ${this.requireIdentity().relayAuth}` },
    });
    return response.ok;
  }

  private async uploadBlobChunk(hash: string, bytes: Uint8Array): Promise<void> {
    const response = await fetch(this.blobUrl(hash), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.requireIdentity().relayAuth}`,
        "Content-Type": "application/octet-stream",
      },
      body: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
    if (!response.ok) {
      throw new Error(
        `Blob upload failed: ${response.status} ${await response.text()}`,
      );
    }
  }

  private async downloadBlobChunk(hash: string): Promise<Uint8Array> {
    const response = await fetch(this.blobUrl(hash), {
      headers: { Authorization: `Bearer ${this.requireIdentity().relayAuth}` },
    });
    if (!response.ok) {
      throw new Error(`Blob download failed: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private upsertNote(note: ExampleNote): void {
    this.db
      .prepare(
        `insert into notes
          (id, body, amount_cents, updated_at_hlc, deleted_at_hlc)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set
          body = excluded.body,
          amount_cents = excluded.amount_cents,
          updated_at_hlc = excluded.updated_at_hlc,
          deleted_at_hlc = excluded.deleted_at_hlc`,
      )
      .run(
        note.id,
        note.body,
        note.amountCents,
        note.updatedAtHlc,
        note.deletedAtHlc,
      );
  }

  private getNote(id: string): ExampleNote | null {
    const row = this.db
      .query<{
        id: string;
        body: string;
        amount_cents: number;
        updated_at_hlc: string;
        deleted_at_hlc: string | null;
      }, [string]>(
        `select id, body, amount_cents, updated_at_hlc, deleted_at_hlc
         from notes
         where id = ?`,
      )
      .get(id);

    if (!row) return null;

    return {
      id: row.id,
      body: row.body,
      amountCents: row.amount_cents,
      updatedAtHlc: row.updated_at_hlc,
      deletedAtHlc: row.deleted_at_hlc,
    };
  }

  private getMeta(key: string): string | null {
    return (
      this.db
        .query<{ value: string }, [string]>(
          `select value from meta where key = ?`,
        )
        .get(key)?.value ?? null
    );
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `insert into meta (key, value)
         values (?, ?)
         on conflict(key) do update set value = excluded.value`,
      )
      .run(key, value);
  }

  private markSeen(eventId: string): void {
    this.db
      .prepare(
        `insert or ignore into sync_seen (event_id, seen_at)
         values (?, ?)`,
      )
      .run(eventId, new Date().toISOString());
  }

  private hasSeen(eventId: string): boolean {
    return Boolean(
      this.db
        .query<{ event_id: string }, [string]>(
          `select event_id from sync_seen where event_id = ?`,
        )
        .get(eventId),
    );
  }

  private nextHlc(): string {
    const now = Date.now();
    const lastTime = Number(this.getMeta(META_HLC_TIME) ?? 0);
    const lastCounter = Number(this.getMeta(META_HLC_COUNTER) ?? 0);
    const nextTime = Math.max(now, lastTime);
    const nextCounter = nextTime === lastTime ? lastCounter + 1 : 0;

    this.setMeta(META_HLC_TIME, String(nextTime));
    this.setMeta(META_HLC_COUNTER, String(nextCounter));

    return createHlc(this.localDeviceId, nextTime, nextCounter);
  }

  private requireIdentity(): LocalFirstIdentity {
    if (!this.identity) throw new Error("Client has not booted.");
    return this.identity;
  }
}
