package main

import (
	"database/sql"
	"encoding/json"
	"strconv"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// store wraps the SQLite database. Reads run concurrently on the pool; writes
// are serialized by writeMu so quota read-modify-write stays atomic (SQLite
// allows only one writer anyway, and WAL keeps readers unblocked meanwhile).
type store struct {
	db      *sql.DB
	writeMu sync.Mutex
}

func openStore(dataDir string) (*store, error) {
	dsn := dbPath(dataDir) +
		"?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if err := db.Ping(); err != nil {
		return nil, err
	}
	return &store{db: db}, nil
}

func (s *store) close() { _ = s.db.Close() }

func (s *store) migrate() error {
	_, err := s.db.Exec(`
		create table if not exists owners (
			owner_id text primary key,
			relay_auth_hash text not null,
			stored_bytes integer not null default 0,
			created_at text not null
		);
		create table if not exists events (
			owner_id text not null,
			event_id text not null,
			device_id text not null,
			envelope_json text not null,
			stored_bytes integer not null,
			created_at text not null,
			stream_id text,
			primary key (owner_id, event_id)
		);
		create index if not exists events_owner_event_id
			on events (owner_id, event_id);
		create index if not exists events_owner_stream
			on events (owner_id, stream_id, event_id);
		create table if not exists blobs (
			owner_id text not null,
			hash text not null,
			bytes blob not null,
			size integer not null,
			created_at text not null,
			primary key (owner_id, hash)
		);
	`)
	if err != nil {
		return err
	}
	// Backfill stream_id on databases created before compaction existed.
	if _, err := s.db.Exec(`alter table events add column stream_id text`); err != nil {
		// column already present — ignore.
	}

	// Monotonic server sequence for a SKIP-PROOF pull cursor. HLC eventIds are
	// not globally ordered across devices, so a cursor based on event_id can
	// permanently skip an event whose HLC sorts below a cursor another device
	// already advanced past (offline/clock-skew). `seq` comes from a counter in
	// relay_meta that only ever increases — never reused even when compaction
	// deletes rows — so `where seq > cursor` can never skip a future event.
	s.db.Exec(`create table if not exists relay_meta (key text primary key, value integer not null)`)
	s.db.Exec(`alter table events add column seq integer`) // ignore if exists
	// Backfill existing rows in insertion order (rowid is monotonic per insert).
	s.db.Exec(`update events set seq = rowid where seq is null`)
	s.db.Exec(`create index if not exists events_owner_seq on events (owner_id, seq)`)
	s.db.Exec(`insert or ignore into relay_meta (key, value) values ('event_seq', 0)`)
	// Seed the counter above the max backfilled seq so new seqs never collide.
	s.db.Exec(`update relay_meta set value = (select coalesce(max(seq), 0) from events)
		where key = 'event_seq' and value < (select coalesce(max(seq), 0) from events)`)
	return nil
}

// --- Owner auth (trust-on-first-use) -----------------------------------------

type authResult struct {
	ok          bool
	storedBytes int64
	status      int
	msg         string
}

// ensureOwnerAuth validates the bearer token against the owner's stored auth
// hash, creating the owner on first use when createIfMissing is set.
func (s *store) ensureOwnerAuth(ownerID, relayAuth string, createIfMissing bool) authResult {
	hash := sha256B64([]byte(relayAuth))

	storedHash, storedBytes, found, err := s.getOwner(ownerID)
	if err != nil {
		return authResult{status: 500, msg: "Internal error"}
	}

	if !found {
		if !createIfMissing {
			return authResult{status: 404, msg: "Unknown owner"}
		}
		s.writeMu.Lock()
		// Re-check inside the lock to avoid a creation race.
		storedHash, storedBytes, found, err = s.getOwner(ownerID)
		if err != nil {
			s.writeMu.Unlock()
			return authResult{status: 500, msg: "Internal error"}
		}
		if !found {
			_, err = s.db.Exec(
				`insert or ignore into owners (owner_id, relay_auth_hash, stored_bytes, created_at)
				 values (?, ?, 0, ?)`,
				ownerID, hash, nowISO(),
			)
			s.writeMu.Unlock()
			if err != nil {
				return authResult{status: 500, msg: "Internal error"}
			}
			return authResult{ok: true, storedBytes: 0}
		}
		s.writeMu.Unlock()
	}

	if storedHash != hash {
		return authResult{status: 401, msg: "Invalid bearer token"}
	}
	return authResult{ok: true, storedBytes: storedBytes}
}

func (s *store) getOwner(ownerID string) (hash string, storedBytes int64, found bool, err error) {
	row := s.db.QueryRow(
		`select relay_auth_hash, stored_bytes from owners where owner_id = ?`, ownerID)
	err = row.Scan(&hash, &storedBytes)
	if err == sql.ErrNoRows {
		return "", 0, false, nil
	}
	if err != nil {
		return "", 0, false, err
	}
	return hash, storedBytes, true, nil
}

func (s *store) ownerStoredBytes(ownerID string) (int64, error) {
	var n int64
	err := s.db.QueryRow(`select stored_bytes from owners where owner_id = ?`, ownerID).Scan(&n)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return n, err
}

// --- Events ------------------------------------------------------------------

type incomingEvent struct {
	raw json.RawMessage
	env SyncEnvelope
}

type pushOutcome struct {
	accepted  int
	duplicate int
	status    int // 0 == success
	msg       string
}

func (s *store) pushEvents(cfg Config, ownerID string, events []incomingEvent) pushOutcome {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return pushOutcome{status: 500, msg: "Failed to store events"}
	}
	defer tx.Rollback()

	var current int64
	if err := tx.QueryRow(`select stored_bytes from owners where owner_id = ?`, ownerID).Scan(&current); err != nil && err != sql.ErrNoRows {
		return pushOutcome{status: 500, msg: "Failed to store events"}
	}

	// Current monotonic seq counter; each newly-inserted event consumes the next.
	var seq int64
	if err := tx.QueryRow(`select value from relay_meta where key = 'event_seq'`).Scan(&seq); err != nil && err != sql.ErrNoRows {
		return pushOutcome{status: 500, msg: "Failed to store events"}
	}

	stmt, err := tx.Prepare(
		`insert or ignore into events
			(owner_id, event_id, device_id, envelope_json, stored_bytes, created_at, stream_id, seq)
		 values (?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return pushOutcome{status: 500, msg: "Failed to store events"}
	}
	defer stmt.Close()

	var delta int64
	accepted, duplicate := 0, 0
	for _, ev := range events {
		storedBytes := int64(len(ev.raw))
		if storedBytes > cfg.MaxEventBytes {
			return pushOutcome{status: 413, msg: "Event is too large"}
		}
		if current+delta+storedBytes > cfg.MaxOwnerBytes {
			return pushOutcome{status: 413, msg: "Owner quota exceeded"}
		}
		var streamID any
		if ev.env.StreamID != "" {
			streamID = ev.env.StreamID
		}
		// Tentative next seq; only consumed if the row is genuinely new.
		res, err := stmt.Exec(ev.env.OwnerID, ev.env.EventID, ev.env.DeviceID,
			string(ev.raw), storedBytes, ev.env.CreatedAt, streamID, seq+1)
		if err != nil {
			return pushOutcome{status: 500, msg: "Failed to store events"}
		}
		if n, _ := res.RowsAffected(); n == 0 {
			duplicate++
		} else {
			accepted++
			delta += storedBytes
			seq++ // consumed by this insert
		}
	}

	if accepted > 0 {
		if _, err := tx.Exec(`update relay_meta set value = ? where key = 'event_seq'`, seq); err != nil {
			return pushOutcome{status: 500, msg: "Failed to store events"}
		}
	}
	if delta > 0 {
		if _, err := tx.Exec(`update owners set stored_bytes = stored_bytes + ? where owner_id = ?`, delta, ownerID); err != nil {
			return pushOutcome{status: 500, msg: "Failed to store events"}
		}
	}
	if err := tx.Commit(); err != nil {
		return pushOutcome{status: 500, msg: "Failed to store events"}
	}
	return pushOutcome{accepted: accepted, duplicate: duplicate}
}

// listEvents returns raw envelope JSON for owner events after the cursor.
func (s *store) listEvents(ownerID, after string, limit int) ([]json.RawMessage, string, error) {
	// The cursor is a monotonic seq. Legacy clients send an HLC eventId string
	// (non-numeric) — treat that as 0 so they re-pull from the start once (the
	// client dedupes by its seen-set), then advance on the seq cursor.
	afterSeq, perr := strconv.ParseInt(after, 10, 64)
	if perr != nil {
		afterSeq = 0
	}
	rows, err := s.db.Query(
		`select seq, envelope_json from events
		 where owner_id = ? and seq > ?
		 order by seq asc limit ?`,
		ownerID, afterSeq, limit)
	if err != nil {
		return nil, after, err
	}
	defer rows.Close()

	events := make([]json.RawMessage, 0, 64)
	cursor := afterSeq
	for rows.Next() {
		var seq int64
		var envelopeJSON string
		if err := rows.Scan(&seq, &envelopeJSON); err != nil {
			return nil, after, err
		}
		events = append(events, json.RawMessage(envelopeJSON))
		cursor = seq
	}
	return events, strconv.FormatInt(cursor, 10), rows.Err()
}

// --- Blobs -------------------------------------------------------------------

func (s *store) blobExists(ownerID, hash string) (bool, error) {
	var one int
	err := s.db.QueryRow(`select 1 from blobs where owner_id = ? and hash = ?`, ownerID, hash).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

func (s *store) getBlob(ownerID, hash string) ([]byte, bool, error) {
	var b []byte
	err := s.db.QueryRow(`select bytes from blobs where owner_id = ? and hash = ?`, ownerID, hash).Scan(&b)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

// putBlob stores a content-addressed chunk and charges usage if newly stored.
func (s *store) putBlob(ownerID, hash string, bytes []byte) (stored bool, err error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	res, err := tx.Exec(
		`insert or ignore into blobs (owner_id, hash, bytes, size, created_at) values (?, ?, ?, ?, ?)`,
		ownerID, hash, bytes, len(bytes), nowISO())
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		if _, err := tx.Exec(`update owners set stored_bytes = stored_bytes + ? where owner_id = ?`, len(bytes), ownerID); err != nil {
			return false, err
		}
		stored = true
	}
	return stored, tx.Commit()
}

// --- Aggregates (for the ops dashboard) --------------------------------------

type storageAgg struct {
	Owners      int64
	Events      int64
	Blobs       int64
	StoredBytes int64
}

func (s *store) aggregates() (storageAgg, error) {
	var a storageAgg
	err := s.db.QueryRow(`
		select
			(select count(*) from owners),
			(select coalesce(sum(stored_bytes), 0) from owners),
			(select count(*) from events),
			(select count(*) from blobs)
	`).Scan(&a.Owners, &a.StoredBytes, &a.Events, &a.Blobs)
	return a, err
}

type ownerUsage struct {
	OwnerID     string `json:"ownerId"`
	StoredBytes int64  `json:"storedBytes"`
}

func (s *store) topOwners(limit int) ([]ownerUsage, error) {
	rows, err := s.db.Query(
		`select owner_id, stored_bytes from owners order by stored_bytes desc limit ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ownerUsage, 0, limit)
	for rows.Next() {
		var o ownerUsage
		if err := rows.Scan(&o.OwnerID, &o.StoredBytes); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// --- Compaction --------------------------------------------------------------

// CompactionResult mirrors the Bun relay's shape for /admin/stats parity.
type CompactionResult struct {
	RanAt          string `json:"ranAt"`
	DeletedEvents  int64  `json:"deletedEvents"`
	ReclaimedBytes int64  `json:"reclaimedBytes"`
	DurationMs     int64  `json:"durationMs"`
}

// compactLog deletes superseded events (every non-highest event_id per
// (owner, stream_id)) and reclaims the owners' usage. Safe because event_id is
// the HLC: the highest per stream is the last-writer-wins value, and any device
// pulling only survivors reconstructs identical state. Untagged events (no
// stream_id) are never touched.
func (s *store) compactLog() (CompactionResult, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	start := time.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return CompactionResult{}, err
	}
	defer tx.Rollback()

	var reclaimed int64
	if err := tx.QueryRow(`
		select coalesce(sum(stored_bytes), 0) from events
		where stream_id is not null
		  and event_id < (select max(e2.event_id) from events e2
		                  where e2.owner_id = events.owner_id and e2.stream_id = events.stream_id)
	`).Scan(&reclaimed); err != nil {
		return CompactionResult{}, err
	}

	// Decrement owner usage by the losers' bytes — must run before the delete.
	if _, err := tx.Exec(`
		update owners set stored_bytes = max(0, stored_bytes - coalesce((
			select sum(e.stored_bytes) from events e
			where e.owner_id = owners.owner_id and e.stream_id is not null
			  and e.event_id < (select max(e2.event_id) from events e2
			                    where e2.owner_id = e.owner_id and e2.stream_id = e.stream_id)
		), 0))
	`); err != nil {
		return CompactionResult{}, err
	}

	res, err := tx.Exec(`
		delete from events where stream_id is not null
		  and event_id < (select max(e2.event_id) from events e2
		                  where e2.owner_id = events.owner_id and e2.stream_id = events.stream_id)
	`)
	if err != nil {
		return CompactionResult{}, err
	}
	deleted, _ := res.RowsAffected()

	if err := tx.Commit(); err != nil {
		return CompactionResult{}, err
	}
	// Return freed pages to the OS so the file stops ballooning.
	if deleted > 0 {
		_, _ = s.db.Exec(`pragma wal_checkpoint(TRUNCATE)`)
	}

	return CompactionResult{
		RanAt:          nowISO(),
		DeletedEvents:  deleted,
		ReclaimedBytes: reclaimed,
		DurationMs:     time.Since(start).Milliseconds(),
	}, nil
}

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}
