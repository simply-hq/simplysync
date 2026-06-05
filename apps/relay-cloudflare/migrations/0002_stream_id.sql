-- Adds the compaction grouping key. The relay groups an owner's events by
-- (owner_id, stream_id) and keeps only the highest event_id (= last-writer-wins
-- value) per group; everything else is a superseded edit it can safely drop.
-- stream_id is a pseudonymous HMAC the relay cannot reverse to a table/row.

alter table events add column stream_id text;

create index if not exists events_owner_stream
  on events (owner_id, stream_id, event_id);
