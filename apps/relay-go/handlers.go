package main

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Below this, gzip's header/CPU overhead isn't worth it — small responses go
// out uncompressed.
const gzipMinBytes = 1024

// SyncEnvelope is the opaque, end-to-end-encrypted event the relay stores. It
// never decrypts ciphertext; streamId (plaintext, pseudonymous) only groups
// events for compaction.
type SyncEnvelope struct {
	Version    int    `json:"version"`
	OwnerID    string `json:"ownerId"`
	EventID    string `json:"eventId"`
	DeviceID   string `json:"deviceId"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
	CreatedAt  string `json:"createdAt"`
	StreamID   string `json:"streamId,omitempty"`
}

func routeHandler(cfg Config, st *store) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		if r.Method == http.MethodOptions {
			writeCORS(w)
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if r.Method == http.MethodGet && path == "/health" {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":         true,
				"service":    "sbt-local-first-relay",
				"version":    relayVersion,
				"serverTime": nowISO(),
			})
			return
		}

		if cfg.AdminToken != "" && (path == cfg.AdminBase ||
			path == cfg.AdminBase+"/stats" || path == cfg.AdminBase+"/compact") {
			handleAdmin(cfg, st, w, r)
			return
		}

		switch {
		case r.Method == http.MethodPost && path == "/v1/events":
			handlePush(cfg, st, w, r)
		case r.Method == http.MethodPost && path == "/v1/streams/compact":
			handleCompactStreams(cfg, st, w, r)
		case r.Method == http.MethodGet && path == "/v1/events":
			handlePull(cfg, st, w, r)
		case r.Method == http.MethodGet && path == "/v1/usage":
			handleUsage(st, w, r)
		case r.Method == http.MethodGet && path == "/v1/status":
			handleStatus(cfg, st, w, r)
		case strings.HasPrefix(path, blobPathPrefix):
			handleBlob(cfg, st, w, r, path)
		default:
			writeJSON(w, http.StatusNotFound, errBody("Not found"))
		}
	})
}

// authDeniedStatus maps a store-level denial to its status code and body
// message. The store deals in reasons; this is the only place they become HTTP,
// so a change to the wire contract can't hide inside a storage decision.
func authDeniedStatus(denial authDenial) (int, string) {
	switch denial {
	case authUnknownOwner:
		return http.StatusNotFound, "Unknown owner"
	case authInvalidToken:
		return http.StatusUnauthorized, "Invalid bearer token"
	case authAtCapacity:
		return http.StatusServiceUnavailable, "Relay is at capacity"
	case authCreateLimited:
		return http.StatusTooManyRequests, "Rate limited"
	default:
		return http.StatusInternalServerError, "Internal error"
	}
}

func writeAuthDenied(w http.ResponseWriter, auth authResult) {
	status, msg := authDeniedStatus(auth.denial)
	writeJSON(w, status, errBody(msg))
}

// pushRejectionStatus is the same mapping for the push path's refusals.
func pushRejectionStatus(rejected pushRejection) (int, string) {
	switch rejected {
	case pushEventTooLarge:
		return http.StatusRequestEntityTooLarge, "Event is too large"
	case pushOwnerQuotaExceeded:
		return http.StatusRequestEntityTooLarge, "Owner quota exceeded"
	case pushRelayFull:
		return http.StatusInsufficientStorage, "Relay storage is full"
	default:
		return http.StatusInternalServerError, "Failed to store events"
	}
}

func handlePush(cfg Config, st *store, w http.ResponseWriter, r *http.Request) {
	relayAuth := bearerToken(r)
	if relayAuth == "" {
		writeJSON(w, http.StatusUnauthorized, errBody("Missing bearer token"))
		return
	}

	if contentLengthExceeds(r, cfg.MaxEventBytes*int64(cfg.MaxEventsPerPush)) {
		writeJSON(w, http.StatusRequestEntityTooLarge, errBody("Payload too large"))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body,
		cfg.MaxEventBytes*int64(cfg.MaxEventsPerPush)+1<<16)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, errBody("Payload too large"))
		return
	}

	var body struct {
		OwnerID string            `json:"ownerId"`
		Events  []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.OwnerID == "" || body.Events == nil {
		writeJSON(w, http.StatusBadRequest, errBody("Invalid push body"))
		return
	}
	if len(body.Events) > cfg.MaxEventsPerPush {
		writeJSON(w, http.StatusRequestEntityTooLarge, errBody("Too many events in one push"))
		return
	}

	events := make([]incomingEvent, 0, len(body.Events))
	for _, rm := range body.Events {
		var env SyncEnvelope
		if err := json.Unmarshal(rm, &env); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("Invalid event"))
			return
		}
		if msg := validateEnvelope(body.OwnerID, env); msg != "" {
			writeJSON(w, http.StatusBadRequest, errBody(msg))
			return
		}
		events = append(events, incomingEvent{raw: rm, env: env})
	}

	auth := st.ensureOwnerAuth(body.OwnerID, relayAuth, true, clientIP(r))
	if !auth.ok {
		writeAuthDenied(w, auth)
		return
	}

	if rateLimitOn && !writeLimiter.allow(body.OwnerID) {
		writeJSON(w, http.StatusTooManyRequests, errBody("Rate limited"))
		return
	}

	out := st.pushEvents(cfg, body.OwnerID, events)
	if out.rejected != pushStored {
		status, msg := pushRejectionStatus(out.rejected)
		writeJSON(w, status, errBody(msg))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accepted": out.accepted, "duplicate": out.duplicate})
}

// streamIDShape is the exact form sealPayload emits: base64url, 22 chars.
var streamIDShape = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

// handleCompactStreams is client-driven tombstone GC: the owner names
// fully-purged streams (opaque HMAC ids — the relay learns nothing about
// tables/rows/contents) and every event of those streams is dropped,
// tombstone included. Only the key holder can compute a streamId and auth
// proves ownership; the client calls this after its own retention window.
// Idempotent: unknown streamIds are a no-op.
func handleCompactStreams(cfg Config, st *store, w http.ResponseWriter, r *http.Request) {
	relayAuth := bearerToken(r)
	if relayAuth == "" {
		writeJSON(w, http.StatusUnauthorized, errBody("Missing bearer token"))
		return
	}

	// 22 chars + JSON quoting/comma overhead — 64 bytes/stream is generous.
	maxBody := int64(64*cfg.MaxStreamsPerCompact + 1024)
	if contentLengthExceeds(r, maxBody) {
		writeJSON(w, http.StatusRequestEntityTooLarge, errBody("Payload too large"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody+1<<10)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, errBody("Payload too large"))
		return
	}

	var body struct {
		OwnerID   string   `json:"ownerId"`
		StreamIDs []string `json:"streamIds"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.OwnerID == "" || body.StreamIDs == nil {
		writeJSON(w, http.StatusBadRequest, errBody("Invalid compact body"))
		return
	}
	if len(body.StreamIDs) > cfg.MaxStreamsPerCompact {
		writeJSON(w, http.StatusRequestEntityTooLarge, errBody("Too many streams in one compact"))
		return
	}
	for _, id := range body.StreamIDs {
		if !streamIDShape.MatchString(id) {
			writeJSON(w, http.StatusBadRequest, errBody("Invalid stream id"))
			return
		}
	}

	// Same gate as push, but never create an owner on a purge call.
	auth := st.ensureOwnerAuth(body.OwnerID, relayAuth, false, "")
	if !auth.ok {
		writeAuthDenied(w, auth)
		return
	}

	if rateLimitOn && !writeLimiter.allow(body.OwnerID) {
		writeJSON(w, http.StatusTooManyRequests, errBody("Rate limited"))
		return
	}

	deleted, reclaimed, err := st.compactStreams(body.OwnerID, body.StreamIDs)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Failed to compact streams"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deletedEvents":  deleted,
		"reclaimedBytes": reclaimed,
	})
}

func handlePull(cfg Config, st *store, w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ownerID := q.Get("ownerId")
	after := q.Get("after")
	relayAuth := bearerToken(r)
	if ownerID == "" || relayAuth == "" {
		writeJSON(w, http.StatusUnauthorized, errBody("Missing ownerId or bearer token"))
		return
	}

	limit := cfg.DefaultEventsPerPull
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > cfg.MaxEventsPerPull {
		limit = cfg.MaxEventsPerPull
	}

	auth := st.ensureOwnerAuth(ownerID, relayAuth, false, "")
	if !auth.ok {
		writeAuthDenied(w, auth)
		return
	}

	events, cursor, err := st.listEvents(ownerID, after, limit, cfg.MaxPullBytes)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Internal error"))
		return
	}
	if events == nil {
		events = []json.RawMessage{}
	}
	// Pull is the one large response; gzip it when the client supports it. The
	// ciphertext won't shrink, but the base64 inflation + repeated JSON
	// scaffolding across a full page of envelopes does.
	writeJSONMaybeGzip(w, r, http.StatusOK, map[string]any{"events": events, "nextCursor": cursor})
}

func handleUsage(st *store, w http.ResponseWriter, r *http.Request) {
	ownerID := r.URL.Query().Get("ownerId")
	relayAuth := bearerToken(r)
	if ownerID == "" || relayAuth == "" {
		writeJSON(w, http.StatusUnauthorized, errBody("Missing ownerId or bearer token"))
		return
	}
	auth := st.ensureOwnerAuth(ownerID, relayAuth, false, "")
	if !auth.ok {
		writeAuthDenied(w, auth)
		return
	}
	n, _ := st.ownerStoredBytes(ownerID)
	writeJSON(w, http.StatusOK, map[string]any{"ownerId": ownerID, "storedBytes": n})
}

// handleStatus is the per-owner health + quota surface a client app polls to
// tell apart "relay down" / "network" / "quota" / "auth" / "healthy-but-behind".
// A reachable-but-never-synced owner gets 404 (Unknown owner) from auth, which
// the client reads as "relay up, account empty".
func handleStatus(cfg Config, st *store, w http.ResponseWriter, r *http.Request) {
	ownerID := r.URL.Query().Get("ownerId")
	relayAuth := bearerToken(r)
	if ownerID == "" || relayAuth == "" {
		writeJSON(w, http.StatusUnauthorized, errBody("Missing ownerId or bearer token"))
		return
	}
	auth := st.ensureOwnerAuth(ownerID, relayAuth, false, "")
	if !auth.ok {
		writeAuthDenied(w, auth)
		return
	}
	status, err := st.ownerStatus(ownerID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Internal error"))
		return
	}
	usedPct := 0.0
	if cfg.MaxOwnerBytes > 0 {
		usedPct = float64(status.StoredBytes) / float64(cfg.MaxOwnerBytes) * 100
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"server": map[string]any{
			"version":    relayVersion,
			"serverTime": nowISO(),
		},
		"account": map[string]any{
			"ownerId":    ownerID,
			"quotaBytes": cfg.MaxOwnerBytes,
			"usedBytes":  status.StoredBytes,
			"usedPct":    usedPct,
			"headSeq":    status.HeadSeq,
			"streams":    status.Streams,
			"events":     status.Events,
			"createdAt":  status.CreatedAt,
		},
	})
}

func handleBlob(cfg Config, st *store, w http.ResponseWriter, r *http.Request, path string) {
	hash := strings.TrimPrefix(path, blobPathPrefix)
	if hash == "" {
		writeJSON(w, http.StatusBadRequest, errBody("Missing blob hash"))
		return
	}
	switch r.Method {
	case http.MethodPut:
		handleBlobPut(cfg, st, w, r, hash)
	case http.MethodGet:
		handleBlobGet(st, w, r, hash)
	case http.MethodHead:
		handleBlobHead(st, w, r, hash)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, errBody("Method not allowed"))
	}
}

func handleBlobPut(cfg Config, st *store, w http.ResponseWriter, r *http.Request, hash string) {
	ownerID := r.URL.Query().Get("ownerId")
	relayAuth := bearerToken(r)
	if ownerID == "" || relayAuth == "" {
		writeJSON(w, http.StatusUnauthorized, errBody("Missing ownerId or bearer token"))
		return
	}

	// Size before auth, because auth here is also the trust-on-first-use owner
	// CREATE path: checking it first let a chunk that can only ever be rejected
	// mint an owner row and spend the relay's global MAX_OWNERS budget. The
	// Cloudflare relay orders it the same way.
	if contentLengthExceeds(r, cfg.MaxBlobBytes) {
		writeJSON(w, http.StatusRequestEntityTooLarge, errBody("Blob chunk is too large"))
		return
	}

	auth := st.ensureOwnerAuth(ownerID, relayAuth, true, clientIP(r))
	if !auth.ok {
		writeAuthDenied(w, auth)
		return
	}

	if rateLimitOn && !writeLimiter.allow(ownerID) {
		writeJSON(w, http.StatusTooManyRequests, errBody("Rate limited"))
		return
	}

	// Dedupe by content hash before reading the body.
	if exists, _ := st.blobExists(ownerID, hash); exists {
		writeJSON(w, http.StatusOK, map[string]any{"stored": false, "duplicate": true})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, cfg.MaxBlobBytes+1<<10)
	bytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, errBody("Blob chunk is too large"))
		return
	}
	if len(bytes) == 0 {
		writeJSON(w, http.StatusBadRequest, errBody("Empty blob"))
		return
	}
	if int64(len(bytes)) > cfg.MaxBlobBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, errBody("Blob chunk is too large"))
		return
	}
	// The path hash must equal the content hash — clients can't choose keys.
	if sha256B64(bytes) != hash {
		writeJSON(w, http.StatusBadRequest, errBody("Blob hash mismatch"))
		return
	}

	// The quota check now lives inside putBlob's locked transaction (see
	// store.go) so it can't race with a concurrent PUT of a distinct hash;
	// there's no cheap, still-correct pre-lock guard worth keeping here.
	stored, err := st.putBlob(cfg, ownerID, hash, bytes)
	if err != nil {
		if errors.Is(err, errBlobQuotaExceeded) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errBody("Owner quota exceeded"))
			return
		}
		if errors.Is(err, errRelayFull) {
			writeJSON(w, http.StatusInsufficientStorage, errBody("Relay storage is full"))
			return
		}
		writeJSON(w, http.StatusInternalServerError, errBody("Failed to store blob"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"stored": stored, "duplicate": !stored})
}

func handleBlobGet(st *store, w http.ResponseWriter, r *http.Request, hash string) {
	ownerID := r.URL.Query().Get("ownerId")
	relayAuth := bearerToken(r)
	if ownerID == "" || relayAuth == "" {
		writeJSON(w, http.StatusUnauthorized, errBody("Missing ownerId or bearer token"))
		return
	}
	auth := st.ensureOwnerAuth(ownerID, relayAuth, false, "")
	if !auth.ok {
		writeAuthDenied(w, auth)
		return
	}
	bytes, ok, err := st.getBlob(ownerID, hash)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Internal error"))
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, errBody("Unknown blob"))
		return
	}
	writeCORS(w)
	w.Header().Set("Content-Type", "application/octet-stream")
	// Encrypted + content-addressed, so it's safe to cache immutably.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(bytes)
}

func handleBlobHead(st *store, w http.ResponseWriter, r *http.Request, hash string) {
	ownerID := r.URL.Query().Get("ownerId")
	relayAuth := bearerToken(r)
	writeCORS(w)
	if ownerID == "" || relayAuth == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	auth := st.ensureOwnerAuth(ownerID, relayAuth, false, "")
	if !auth.ok {
		status, _ := authDeniedStatus(auth.denial)
		w.WriteHeader(status)
		return
	}
	exists, _ := st.blobExists(ownerID, hash)
	if exists {
		w.WriteHeader(http.StatusOK)
	} else {
		w.WriteHeader(http.StatusNotFound)
	}
}

func validateEnvelope(ownerID string, env SyncEnvelope) string {
	if env.Version != 1 {
		return "Unsupported event version"
	}
	if env.OwnerID != ownerID {
		return "Event owner mismatch"
	}
	if env.EventID == "" {
		return "Missing eventId"
	}
	hlcState := classifyHLCAt(env.EventID, time.Now().UnixMilli())
	if hlcState == hlcMalformed {
		return "Invalid eventId"
	}
	if hlcState == hlcFuture {
		return "Future eventId"
	}
	if env.DeviceID == "" {
		return "Missing deviceId"
	}
	if env.Nonce == "" {
		return "Missing nonce"
	}
	if env.Ciphertext == "" {
		return "Missing ciphertext"
	}
	if env.CreatedAt == "" {
		return "Missing createdAt"
	}
	// A present streamId must be the exact shape sealPayload emits. An absent
	// one (JSON null/omitted, which unmarshals to "") means "no stream" and is
	// left alone. This keeps a malformed id — which the compaction grouping key
	// is built from — off the wire on both relays, not just Cloudflare.
	if env.StreamID != "" && !streamIDShape.MatchString(env.StreamID) {
		return "Invalid streamId"
	}
	return ""
}

// --- HTTP helpers ------------------------------------------------------------

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
}

// contentLengthExceeds reports whether the request declares a body larger than
// max. A missing/unparseable Content-Length is not treated as exceeding (the
// per-path MaxBytesReader / size check still bounds it). Mirrors the
// Cloudflare relay's exceedsContentLength — reject the cheapest-to-send
// oversized junk before it's buffered.
func contentLengthExceeds(r *http.Request, max int64) bool {
	if r.ContentLength <= 0 {
		return false
	}
	return r.ContentLength > max
}

func clientIP(r *http.Request) string {
	// Forwarding headers are client-forgeable on a directly-exposed relay, so
	// they gate the per-IP limiters and admin lockout only when the operator
	// asserts a trusted proxy sets them (TRUST_PROXY_HEADERS). Otherwise the
	// real socket peer is the only key an attacker can't rotate per request.
	if trustProxyHeaders {
		if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
			return ip
		}
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			return strings.TrimSpace(strings.Split(xff, ",")[0])
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}
	return "local"
}

func writeCORS(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, HEAD, OPTIONS")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	writeCORS(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func acceptsGzip(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
}

// Like writeJSON, but gzips the body when the client advertises gzip support
// and the payload is large enough to benefit. Vary: Accept-Encoding keeps a
// cache from serving a gzipped body to a client that can't decode it.
func writeJSONMaybeGzip(w http.ResponseWriter, r *http.Request, status int, body any) {
	data, err := json.Marshal(body)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Internal error"))
		return
	}
	writeCORS(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Vary", "Accept-Encoding")
	if len(data) >= gzipMinBytes && acceptsGzip(r) {
		w.Header().Set("Content-Encoding", "gzip")
		w.WriteHeader(status)
		gz := gzip.NewWriter(w)
		_, _ = gz.Write(data)
		_ = gz.Close()
		return
	}
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func errBody(msg string) map[string]any { return map[string]any{"error": msg} }
