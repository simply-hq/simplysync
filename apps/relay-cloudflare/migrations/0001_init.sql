-- D1 schema for the Cloudflare relay.
--
-- Only small rows live here: owner metadata, the encrypted event log, and a
-- counters table. Large binary blobs live in R2 (see src/index.ts), so this
-- database stays well under D1's per-database size ceiling even at scale.

create table if not exists owners (
  owner_id        text primary key,
  relay_auth_hash text not null,
  stored_bytes    integer not null default 0,
  created_at      text not null
);

create table if not exists events (
  owner_id      text not null,
  event_id      text not null,
  device_id     text not null,
  envelope_json text not null,
  stored_bytes  integer not null,
  created_at    text not null,
  stream_id     text,
  -- Monotonic server sequence: the pull cursor. HLC eventIds aren't globally
  -- ordered across devices, so an event_id cursor can permanently skip an
  -- offline/clock-skewed event. `seq` comes from the relay_meta 'event_seq'
  -- counter (only increases, never reused across compaction deletes).
  seq           integer,
  primary key (owner_id, event_id)
);

-- Keyset cursor for pull (where owner_id = ? and seq > ? order by seq).
create index if not exists events_owner_seq
  on events (owner_id, seq);

-- Blob *metadata* only; the bytes themselves live in R2. Kept so usage
-- accounting and dedupe checks don't need an R2 round-trip.
create table if not exists blobs (
  owner_id   text not null,
  hash       text not null,
  size       integer not null,
  created_at text not null,
  primary key (owner_id, hash)
);

-- Single-row global counters used to bound total fleet size cheaply
-- (no count(*) scans on the hot path).
create table if not exists relay_meta (
  key   text primary key,
  value integer not null
);

insert or ignore into relay_meta (key, value) values ('owner_count', 0);
insert or ignore into relay_meta (key, value) values ('event_seq', 0);
