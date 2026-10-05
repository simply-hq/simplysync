package main

import (
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// errBlobQuotaExceeded signals a blob PUT that would push the owner over
// MaxOwnerBytes; handleBlobPut owns what that becomes on the wire.
var errBlobQuotaExceeded = errors.New("owner quota exceeded")

// errRelayFull signals a write that would push the relay over the global
// MaxTotalBytes ceiling (opt-in). handleBlobPut / the push path turn it into 507.
var errRelayFull = errors.New("relay storage is full")

// store wraps the SQLite database. Reads run concurrently on the pool; writes
// are serialized by writeMu so quota read-modify-write stays atomic (SQLite
// allows only one writer anyway, and WAL keeps readers unblocked meanwhile).
type store struct {
	db        *sql.DB
	writeMu   sync.Mutex
	maxOwners int
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
	// closed_at marks an owner retired via `POST /v1/owner/close` (leaked
	// recovery phrase). The row is kept on purpose: owners are created on first
	// push, so deleting it would let anyone holding the old token recreate it.
	if _, err := s.db.Exec(`alter table owners add column closed_at text`); err != nil {
		// column already present — ignore.
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

	// Global owner cap counter (mirrors event_seq's backfill pattern and the
	// Cloudflare relay's owner_count). One counter row, so the create path
	// never runs count(*) on owners. Seed it from the current owner count on
	// first upgrade; owners are never deleted, so it stays accurate.
	s.db.Exec(`insert or ignore into relay_meta (key, value) values ('owner_count', 0)`)
	s.db.Exec(`update relay_meta set value = (select count(*) from owners)
		where key = 'owner_count' and value < (select count(*) from owners)`)
	return nil
}

// --- Owner auth (trust-on-first-use) -----------------------------------------

// authDenial is why the store refused a request, in the store's own terms.
// handlers.go maps each to a status code and a message; this file never names
// one, which is what keeps the store HTTP-free and directly testable.
type authDenial int

const (
	// The zero value on purpose: a denial nobody set is a server-side failure,
	// never an accidental grant.
	authInternalError authDenial = iota
	authUnknownOwner
	authInvalidToken
	authAtCapacity
	authCreateLimited
	// Valid token, but the owner was closed. Only reported after the token
	// checks out, so a closed account is indistinguishable to anyone else.
	authOwnerClosed
)

type authResult struct {
	ok     bool
	denial authDenial
}

// ensureOwnerAuth validates the bearer token against the owner's stored auth
// hash, creating the owner on first use when createIfMissing is set.
// createLimitKey (the client IP) is checked against the per-IP owner-creation
// limiter, but only on the path that would actually mint a new owner; callers
// that never create pass "".
func (s *store) ensureOwnerAuth(ownerID, relayAuth string, createIfMissing bool, createLimitKey string) authResult {
	hash := sha256B64([]byte(relayAuth))

	storedHash, closed, found, err := s.getOwner(ownerID)
	if err != nil {
		return authResult{denial: authInternalError}
	}

	if !found {
		if !createIfMissing {
			return authResult{denial: authUnknownOwner}
		}
		s.writeMu.Lock()
		// Re-check inside the lock to avoid a creation race.
		storedHash, closed, found, err = s.getOwner(ownerID)
		if err != nil {
			s.writeMu.Unlock()
			return authResult{denial: authInternalError}
		}
		if !found {
			// Per-IP owner-creation limit, checked only now that we know a new
			// owner would actually be minted (so an existing owner's normal
			// pushes never consume the create budget). Mirrors the Cloudflare
			// relay's CREATE_LIMITER.
			if createLimitKey != "" && rateLimitOn && createLimiter != nil &&
				!createLimiter.allow(createLimitKey) {
				s.writeMu.Unlock()
				return authResult{denial: authCreateLimited}
			}
			// Enforce the global owner cap atomically with the insert: bump the
			// counter only while it's below the cap, insert only if the bump
			// took. Under writeMu, so no concurrent writer can interleave.
			tx, err := s.db.Begin()
			if err != nil {
				s.writeMu.Unlock()
				return authResult{denial: authInternalError}
			}
			res, err := tx.Exec(`update relay_meta set value = value + 1
				where key = 'owner_count' and value < ?`, s.maxOwners)
			if err != nil {
				_ = tx.Rollback()
				s.writeMu.Unlock()
				return authResult{denial: authInternalError}
			}
			if n, _ := res.RowsAffected(); n == 0 {
				_ = tx.Rollback()
				s.writeMu.Unlock()
				return authResult{denial: authAtCapacity}
			}
			if _, err := tx.Exec(
				`insert or ignore into owners (owner_id, relay_auth_hash, stored_bytes, created_at)
				 values (?, ?, 0, ?)`,
				ownerID, hash, nowISO(),
			); err != nil {
				_ = tx.Rollback()
				s.writeMu.Unlock()
				return authResult{denial: authInternalError}
			}
			if err := tx.Commit(); err != nil {
				s.writeMu.Unlock()
				return authResult{denial: authInternalError}
			}
			s.writeMu.Unlock()
			return authResult{ok: true}
		}
		s.writeMu.Unlock()
	}

	// Constant-time: storedHash and hash are equal-length base64 SHA-256
	// digests, so a plain != would leak a timing signal on the primary auth
	// check SECURITY.md points auditors straight at. The admin path already
	// uses subtle; match it here.
	if subtle.ConstantTimeCompare([]byte(storedHash), []byte(hash)) != 1 {
		return authResult{denial: authInvalidToken}
	}
	if closed {
		return authResult{denial: authOwnerClosed}
	}
	return authResult{ok: true}
}

func (s *store) getOwner(ownerID string) (hash string, closed bool, found bool, err error) {
	var closedAt sql.NullString
	row := s.db.QueryRow(
		`select relay_auth_hash, closed_at from owners where owner_id = ?`, ownerID)
	err = row.Scan(&hash, &closedAt)
	if err == sql.ErrNoRows {
		return "", false, false, nil
	}
	if err != nil {
		return "", false, false, err
	}
	return hash, closedAt.Valid, true, nil
}

// closeOwner retires an owner for good: every event and blob is deleted and
// the row is marked closed, so later pushes and pulls get 410 instead of
// recreating it. Callers have already checked the token. Idempotent.
func (s *store) closeOwner(ownerID string) (deletedEvents int64, deletedBlobs int64, err error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	res, err := tx.Exec(`delete from events where owner_id = ?`, ownerID)
	if err != nil {
		return 0, 0, err
	}
	deletedEvents, _ = res.RowsAffected()
	res, err = tx.Exec(`delete from blobs where owner_id = ?`, ownerID)
	if err != nil {
		return 0, 0, err
	}
	deletedBlobs, _ = res.RowsAffected()
	if _, err := tx.Exec(
		`update owners set stored_bytes = 0, closed_at = coalesce(closed_at, ?) where owner_id = ?`,
		nowISO(), ownerID,
	); err != nil {
		return 0, 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	if deletedEvents > 0 || deletedBlobs > 0 {
		_, _ = s.db.Exec(`pragma wal_checkpoint(TRUNCATE)`)
	}
	return deletedEvents, deletedBlobs, nil
}

func (s *store) ownerStoredBytes(ownerID string) (int64, error) {
	var n int64
	err := s.db.QueryRow(`select stored_bytes from owners where owner_id = ?`, ownerID).Scan(&n)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return n, err
}

// ownerStatusInfo is the per-owner snapshot behind GET /v1/status: usage +
// head cursor + entity counts. Streams counts distinct stream_ids (≈ live
// entities); Events is the raw stored count (collapses to Streams under
// compaction / the KV redesign).
type ownerStatusInfo struct {
	StoredBytes int64
	CreatedAt   string
	HeadSeq     int64
	Events      int64
	Streams     int64
}

func (s *store) ownerStatus(ownerID string) (ownerStatusInfo, error) {
	var info ownerStatusInfo
	err := s.db.QueryRow(`select stored_bytes, created_at from owners where owner_id = ?`, ownerID).
		Scan(&info.StoredBytes, &info.CreatedAt)
	if err == sql.ErrNoRows {
		return info, nil
	}
	if err != nil {
		return info, err
	}
	// Head cursor + counts use the owner-scoped indexes (events_owner_seq,
	// events_owner_stream), so these stay cheap.
	if err := s.db.QueryRow(
		`select coalesce(max(seq), 0), count(*), count(distinct stream_id)
		 from events where owner_id = ?`, ownerID).
		Scan(&info.HeadSeq, &info.Events, &info.Streams); err != nil {
		return info, err
	}
	return info, nil
}

// --- Events ------------------------------------------------------------------

type incomingEvent struct {
	raw json.RawMessage
	env SyncEnvelope
}

// pushRejection is why a push stored nothing, in the store's own terms.
// pushStored is the zero value, so an outcome that rejected nothing is a
// stored one — the same shape the old `status == 0` check had, without the
// store having to know what a 413 is.
type pushRejection int

const (
	pushStored pushRejection = iota
	pushStoreFailed
	pushEventTooLarge
	pushOwnerQuotaExceeded
	pushRelayFull
)

type pushOutcome struct {
	accepted  int
	duplicate int
	rejected  pushRejection
}

func (s *store) pushEvents(cfg Config, ownerID string, events []incomingEvent) pushOutcome {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return pushOutcome{rejected: pushStoreFailed}
	}
	defer tx.Rollback()

	var current int64
	if err := tx.QueryRow(`select stored_bytes from owners where owner_id = ?`, ownerID).Scan(&current); err != nil && err != sql.ErrNoRows {
		return pushOutcome{rejected: pushStoreFailed}
	}

	// Current monotonic seq counter; each newly-inserted event consumes the next.
	var seq int64
	if err := tx.QueryRow(`select value from relay_meta where key = 'event_seq'`).Scan(&seq); err != nil && err != sql.ErrNoRows {
		return pushOutcome{rejected: pushStoreFailed}
	}

	stmt, err := tx.Prepare(
		`insert or ignore into events
			(owner_id, event_id, device_id, envelope_json, stored_bytes, created_at, stream_id, seq)
		 values (?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return pushOutcome{rejected: pushStoreFailed}
	}
	defer stmt.Close()

	var delta int64
	accepted, duplicate := 0, 0
	for _, ev := range events {
		// Byte-accounting basis (frozen, plan 009): raw received envelope
		// bytes. Cloudflare measures JSON.stringify(event) instead — identical
		// for compliant canonical envelopes; the conformance suite's
		// cross-relay comparison guards that they stay equal.
		storedBytes := int64(len(ev.raw))
		if storedBytes > cfg.MaxEventBytes {
			return pushOutcome{rejected: pushEventTooLarge}
		}
		var streamID any
		if ev.env.StreamID != "" {
			streamID = ev.env.StreamID
		}
		// Tentative next seq; only consumed if the row is genuinely new.
		res, err := stmt.Exec(ev.env.OwnerID, ev.env.EventID, ev.env.DeviceID,
			string(ev.raw), storedBytes, ev.env.CreatedAt, streamID, seq+1)
		if err != nil {
			return pushOutcome{rejected: pushStoreFailed}
		}
		if n, _ := res.RowsAffected(); n == 0 {
			// A duplicate stores nothing, so it is charged nothing and can
			// never push the owner over quota: re-pushing events the relay
			// already holds is what a flaky network produces, and it must
			// stay a free no-op even at the cap. The quota check therefore
			// runs AFTER the insert, on genuinely-new bytes only — the same
			// rule the Cloudflare relay applies to its accepted bytes.
			duplicate++
			continue
		}
		if current+delta+storedBytes > cfg.MaxOwnerBytes {
			// The insert above dies with the transaction (deferred rollback),
			// so an over-quota push stores nothing at all.
			return pushOutcome{rejected: pushOwnerQuotaExceeded}
		}
		accepted++
		delta += storedBytes
		seq++ // consumed by this insert
	}

	if accepted > 0 {
		if _, err := tx.Exec(`update relay_meta set value = ? where key = 'event_seq'`, seq); err != nil {
			return pushOutcome{rejected: pushStoreFailed}
		}
	}
	if delta > 0 {
		// Global storage ceiling (opt-in): per-owner quotas bound one tenant,
		// but MAX_OWNERS × MAX_OWNER_BYTES multiply to far more than a small
		// VPS holds, so a few full owners can fill the disk and fail writes for
		// everyone. Checked inside the same locked txn that charges usage, on
		// genuinely-new bytes only, so it can't corrupt accounting.
		if cfg.MaxTotalBytes > 0 {
			var total int64
			if err := tx.QueryRow(`select coalesce(sum(stored_bytes), 0) from owners`).Scan(&total); err != nil {
				return pushOutcome{rejected: pushStoreFailed}
			}
			if total+delta > cfg.MaxTotalBytes {
				return pushOutcome{rejected: pushRelayFull}
			}
		}
		if _, err := tx.Exec(`update owners set stored_bytes = stored_bytes + ? where owner_id = ?`, delta, ownerID); err != nil {
			return pushOutcome{rejected: pushStoreFailed}
		}
	}
	if err := tx.Commit(); err != nil {
		return pushOutcome{rejected: pushStoreFailed}
	}
	return pushOutcome{accepted: accepted, duplicate: duplicate}
}

// listEvents returns raw envelope JSON for owner events after the cursor.
func (s *store) listEvents(ownerID, after string, limit int, maxBytes int64) ([]json.RawMessage, string, error) {
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
	var accumulated int64
	for rows.Next() {
		var seq int64
		var envelopeJSON string
		if err := rows.Scan(&seq, &envelopeJSON); err != nil {
			return nil, after, err
		}
		events = append(events, json.RawMessage(envelopeJSON))
		cursor = seq
		// Bound the page by bytes as well as count: at the 256 KiB/event max,
		// a count-only cap of 1000-5000 lets one page reach hundreds of MiB and
		// OOM a small VPS. Stop after at least one row so the pull always makes
		// forward progress; the client loops on nextCursor.
		accumulated += int64(len(envelopeJSON))
		if maxBytes > 0 && accumulated >= maxBytes {
			break
		}
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
// The quota check runs inside this same locked transaction, after
// determining the row is genuinely new (a duplicate is neither charged nor
// rejected) and before committing — an overshoot rolls the insert back via
// the deferred tx.Rollback() and returns errBlobQuotaExceeded. This closes
// the race where the event-push path already charges atomically but blob
// PUT used to check quota outside the lock (SECURITY-03).
func (s *store) putBlob(cfg Config, ownerID, hash string, bytes []byte) (stored bool, err error) {
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
		var current int64
		if err := tx.QueryRow(`select stored_bytes from owners where owner_id = ?`, ownerID).Scan(&current); err != nil && err != sql.ErrNoRows {
			return false, err
		}
		if current+int64(len(bytes)) > cfg.MaxOwnerBytes {
			return false, errBlobQuotaExceeded
		}
		if cfg.MaxTotalBytes > 0 {
			var total int64
			if err := tx.QueryRow(`select coalesce(sum(stored_bytes), 0) from owners`).Scan(&total); err != nil {
				return false, err
			}
			if total+int64(len(bytes)) > cfg.MaxTotalBytes {
				return false, errRelayFull
			}
		}
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

// CompactionResult is returned by the admin maintenance API.
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
// compactStreams drops every event of the given (owner, streamId) groups —
// winners and tombstones included: the owner has asserted the logical rows
// are fully purged (client-driven tombstone GC, `POST /v1/streams/compact`).
// Mirrors compactLog's accounting: sum the victims' bytes, decrement the
// owner's usage (clamped >= 0), delete, then return freed pages to the OS.
// Per-stream statements in one transaction keep SQL arity constant.
func (s *store) compactStreams(ownerID string, streamIDs []string) (deleted int64, reclaimed int64, err error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	for _, streamID := range streamIDs {
		var bytes int64
		if err := tx.QueryRow(
			`select coalesce(sum(stored_bytes), 0) from events where owner_id = ? and stream_id = ?`,
			ownerID, streamID,
		).Scan(&bytes); err != nil {
			return 0, 0, err
		}
		res, err := tx.Exec(
			`delete from events where owner_id = ? and stream_id = ?`,
			ownerID, streamID,
		)
		if err != nil {
			return 0, 0, err
		}
		n, _ := res.RowsAffected()
		if n > 0 {
			deleted += n
			reclaimed += bytes
		}
	}

	if reclaimed > 0 {
		if _, err := tx.Exec(
			`update owners set stored_bytes = max(0, stored_bytes - ?) where owner_id = ?`,
			reclaimed, ownerID,
		); err != nil {
			return 0, 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	if deleted > 0 {
		_, _ = s.db.Exec(`pragma wal_checkpoint(TRUNCATE)`)
	}
	return deleted, reclaimed, nil
}

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
