package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// contentLengthExceeds is a cheap pre-filter, not the real bound: it rejects
// oversized junk before the body is buffered. A request that declares no
// length, or an unparseable one, must therefore fall through to the per-path
// MaxBytesReader rather than being rejected on a header a client controls.
func TestContentLengthExceeds(t *testing.T) {
	const max int64 = 1024

	cases := []struct {
		name          string
		contentLength int64
		want          bool
	}{
		{"under the limit", 512, false},
		{"exactly at the limit", max, false},
		{"over the limit", max + 1, true},
		{"absent (chunked or streamed)", 0, false},
		{"unknown (-1, as net/http reports it)", -1, false},
	}

	for _, tc := range cases {
		r := httptest.NewRequest("POST", "/v1/events", strings.NewReader(""))
		r.ContentLength = tc.contentLength
		if got := contentLengthExceeds(r, max); got != tc.want {
			t.Errorf("%s: contentLengthExceeds(len=%d, max=%d) = %v, want %v",
				tc.name, tc.contentLength, max, got, tc.want)
		}
	}
}

// bearerToken is the only thing standing between a request and an owner's
// stream, so its parsing has to be exact: no scheme, a different scheme, or a
// token that is only whitespace must all read as "no credential".
func TestBearerToken(t *testing.T) {
	cases := []struct {
		header string
		want   string
	}{
		{"Bearer abc123", "abc123"},
		{"Bearer   abc123  ", "abc123"},
		{"", ""},
		{"abc123", ""},
		{"Basic abc123", ""},
		{"bearer abc123", ""}, // case-sensitive by RFC-adjacent convention here
		{"Bearer ", ""},
		{"Bearer    ", ""},
	}

	for _, tc := range cases {
		r := httptest.NewRequest("GET", "/v1/events", nil)
		if tc.header != "" {
			r.Header.Set("Authorization", tc.header)
		}
		if got := bearerToken(r); got != tc.want {
			t.Errorf("bearerToken(%q) = %q, want %q", tc.header, got, tc.want)
		}
	}
}

// validateEnvelope is the relay's whole view of an event: it cannot read the
// ciphertext, so every field it *can* check has to be checked. A missing nonce
// or ciphertext would be stored as an event no device can ever decrypt.
func TestValidateEnvelopeRequiresEveryRoutingField(t *testing.T) {
	good := SyncEnvelope{
		Version:    1,
		OwnerID:    "owner-1",
		EventID:    "00loyw3v28-000z-device",
		DeviceID:   "device",
		Nonce:      "nonce",
		Ciphertext: "ct",
		CreatedAt:  "2026-01-01T00:00:00.000Z",
	}
	if msg := validateEnvelope("owner-1", good); msg != "" {
		t.Fatalf("valid envelope rejected: %s", msg)
	}

	cases := []struct {
		name   string
		mutate func(e *SyncEnvelope)
		want   string
	}{
		{"unsupported version", func(e *SyncEnvelope) { e.Version = 2 }, "Unsupported event version"},
		{"owner mismatch", func(e *SyncEnvelope) { e.OwnerID = "someone-else" }, "Event owner mismatch"},
		{"missing eventId", func(e *SyncEnvelope) { e.EventID = "" }, "Missing eventId"},
		{"malformed eventId", func(e *SyncEnvelope) { e.EventID = "garbage" }, "Invalid eventId"},
		{"missing deviceId", func(e *SyncEnvelope) { e.DeviceID = "" }, "Missing deviceId"},
		{"missing nonce", func(e *SyncEnvelope) { e.Nonce = "" }, "Missing nonce"},
		{"missing ciphertext", func(e *SyncEnvelope) { e.Ciphertext = "" }, "Missing ciphertext"},
		{"missing createdAt", func(e *SyncEnvelope) { e.CreatedAt = "" }, "Missing createdAt"},
	}

	for _, tc := range cases {
		env := good
		tc.mutate(&env)
		if msg := validateEnvelope("owner-1", env); msg != tc.want {
			t.Errorf("%s: validateEnvelope = %q, want %q", tc.name, msg, tc.want)
		}
	}
}

// The shape rule the compaction endpoint enforces. It is the only defence
// against a stream id that could never have come from deriveStreamId, and the
// exact form sealPayload emits is base64url truncated to 22 characters.
func TestStreamIDShape(t *testing.T) {
	valid := []string{
		"AAAAAAAAAAAAAAAAAAAAAA",
		"abcdefghij_klmnop-qrst",
		"0123456789012345678901",
	}
	for _, id := range valid {
		if !streamIDShape.MatchString(id) {
			t.Errorf("streamIDShape rejected a valid id: %q", id)
		}
	}

	invalid := []string{
		"",
		"AAAAAAAAAAAAAAAAAAAAA",   // 21 chars
		"AAAAAAAAAAAAAAAAAAAAAAA", // 23 chars
		"AAAAAAAAAAAAAAAAAAAA==",  // base64 padding is not base64url
		"AAAAAAAAAAAAAAAAAAAA/+",  // standard base64 alphabet
		"AAAAAAAAAAAAAAAAAAAA A",
		"'; drop table events--",
	}
	for _, id := range invalid {
		if streamIDShape.MatchString(id) {
			t.Errorf("streamIDShape accepted an invalid id: %q", id)
		}
	}
}

// compactLog is the relay-side echo of last-writer-wins: within a stream, only
// the highest event id survives. An event with no stream id has no stream to be
// superseded within, so it must be left alone — otherwise a client that sealed
// before stream ids existed (or any port that omits them) would silently lose
// every event but one.
func TestCompactLogNeverTouchesUntaggedEvents(t *testing.T) {
	st, err := openStore(t.TempDir())
	if err != nil {
		t.Fatalf("openStore: %v", err)
	}
	defer st.close()
	st.maxOwners = 10
	if err := st.migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	cfg := Config{MaxEventBytes: 1 << 20, MaxOwnerBytes: 1 << 30}
	const owner = "owner-untagged"
	if auth := st.ensureOwnerAuth(owner, "write-key", true, ""); !auth.ok {
		t.Fatalf("ensureOwnerAuth denied: %d", auth.denial)
	}

	event := func(id, streamID string) incomingEvent {
		env := SyncEnvelope{
			Version: 1, OwnerID: owner, EventID: id, DeviceID: "device",
			Nonce: "n", Ciphertext: "c", CreatedAt: "2026-01-01T00:00:00.000Z",
			StreamID: streamID,
		}
		return incomingEvent{raw: []byte(`{"eventId":"` + id + `"}`), env: env}
	}

	// Three untagged events, plus one stream with two events in it.
	out := st.pushEvents(cfg, owner, []incomingEvent{
		event("00loyw3v28-0000-device", ""),
		event("00loyw3v28-0001-device", ""),
		event("00loyw3v28-0002-device", ""),
		event("00loyw3v29-0000-device", "AAAAAAAAAAAAAAAAAAAAAA"),
		event("00loyw3v29-0001-device", "AAAAAAAAAAAAAAAAAAAAAA"),
	})
	if out.rejected != pushStored || out.accepted != 5 {
		t.Fatalf("push: rejected=%d accepted=%d", out.rejected, out.accepted)
	}

	result, err := st.compactLog()
	if err != nil {
		t.Fatalf("compactLog: %v", err)
	}
	// Exactly one loser: the lower of the two events sharing a stream.
	if result.DeletedEvents != 1 {
		t.Fatalf("DeletedEvents = %d, want 1", result.DeletedEvents)
	}

	var untagged, tagged int64
	if err := st.db.QueryRow(
		`select count(*) from events where owner_id = ? and stream_id is null`, owner,
	).Scan(&untagged); err != nil {
		t.Fatalf("count untagged: %v", err)
	}
	if err := st.db.QueryRow(
		`select count(*) from events where owner_id = ? and stream_id is not null`, owner,
	).Scan(&tagged); err != nil {
		t.Fatalf("count tagged: %v", err)
	}
	if untagged != 3 {
		t.Errorf("untagged events = %d, want 3 (compaction must not touch them)", untagged)
	}
	if tagged != 1 {
		t.Errorf("tagged events = %d, want 1 (the stream's winner)", tagged)
	}

	// And it is the *highest* event id that survived, not merely one of them.
	var winner string
	if err := st.db.QueryRow(
		`select event_id from events where owner_id = ? and stream_id is not null`, owner,
	).Scan(&winner); err != nil {
		t.Fatalf("winner: %v", err)
	}
	if winner != "00loyw3v29-0001-device" {
		t.Errorf("stream winner = %q, want the highest event id", winner)
	}
}
