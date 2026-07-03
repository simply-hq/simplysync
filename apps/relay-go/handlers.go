package main

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
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
				"service":    "simplysync-relay",
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

	auth := st.ensureOwnerAuth(body.OwnerID, relayAuth, true)
	if !auth.ok {
		writeJSON(w, auth.status, errBody(auth.msg))
		return
	}

	if rateLimitOn && !writeLimiter.allow(body.OwnerID) {
		writeJSON(w, http.StatusTooManyRequests, errBody("Rate limited"))
		return
	}

	out := st.pushEvents(cfg, body.OwnerID, events)
	if out.status != 0 {
		writeJSON(w, out.status, errBody(out.msg))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accepted": out.accepted, "duplicate": out.duplicate})
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

	auth := st.ensureOwnerAuth(ownerID, relayAuth, false)
	if !auth.ok {
		writeJSON(w, auth.status, errBody(auth.msg))
		return
	}

	events, cursor, err := st.listEvents(ownerID, after, limit)
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
	auth := st.ensureOwnerAuth(ownerID, relayAuth, false)
	if !auth.ok {
		writeJSON(w, auth.status, errBody(auth.msg))
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
	auth := st.ensureOwnerAuth(ownerID, relayAuth, false)
	if !auth.ok {
		writeJSON(w, auth.status, errBody(auth.msg))
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

	auth := st.ensureOwnerAuth(ownerID, relayAuth, true)
	if !auth.ok {
		writeJSON(w, auth.status, errBody(auth.msg))
		return
	}

	if contentLengthExceeds(r, cfg.MaxBlobBytes) {
		writeJSON(w, http.StatusRequestEntityTooLarge, errBody("Blob chunk is too large"))
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
	auth := st.ensureOwnerAuth(ownerID, relayAuth, false)
	if !auth.ok {
		writeJSON(w, auth.status, errBody(auth.msg))
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
	auth := st.ensureOwnerAuth(ownerID, relayAuth, false)
	if !auth.ok {
		w.WriteHeader(auth.status)
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
	if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
		return ip
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
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
