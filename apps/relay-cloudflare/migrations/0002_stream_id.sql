-- Adds the compaction grouping index. The relay groups an owner's events by
-- (owner_id, stream_id) and keeps only the highest event_id (= last-writer-wins
-- value) per group; everything else is a superseded edit it can safely drop.
-- stream_id is a pseudonymous HMAC the relay cannot reverse to a table/row.
--
-- The `stream_id` column itself is defined directly on the events table in
-- 0001_init.sql. This migration used to `alter table events add column
-- stream_id text` here, but once the column was folded into 0001 that made a
-- FRESH D1 fail with "duplicate column name: stream_id" (0001 creates it, then
-- 0002 tried to add it again). Removed. Existing deployments already recorded
-- 0002 as applied (D1 tracks migrations by file) and are unaffected — they ran
-- the historical 0001 (without stream_id) then the old 0002 that added it, so
-- their schema is identical to a fresh deploy's.

create index if not exists events_owner_stream
  on events (owner_id, stream_id, event_id);
