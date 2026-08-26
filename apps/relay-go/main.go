// Cloudflare-free, single-binary relay for the local-first sync protocol.
//
// Canonical self-hosted relay: the same endpoints, request/response shapes, and
// end-to-end-encrypted threat model as the Cloudflare relay (the relay only ever
// holds ciphertext + an owner id + an auth hash). It deploys as a single static
// binary with stable, low memory — no runtime to install on the box.
package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config is resolved from the environment at startup.
type Config struct {
	Port                 int
	DataDir              string
	AdminToken           string
	AdminBase            string
	MaxEventBytes        int64
	MaxOwnerBytes        int64
	MaxTotalBytes        int64
	MaxEventsPerPush     int
	MaxEventsPerPull     int
	DefaultEventsPerPull int
	MaxPullBytes         int64
	MaxStreamsPerCompact int
	MaxBlobBytes         int64
	CompactionInterval   time.Duration
	MaxOwners            int
	RateLimitEnabled     bool
	RateLimitAPI         int
	RateLimitWrite       int
	RateLimitCreate      int
	TrustProxyHeaders    bool
}

const blobPathPrefix = "/v1/blobs/"

// relayVersion is reported by /health and /v1/status so clients can tell which
// relay build they're talking to when diagnosing sync issues.
const relayVersion = "1.0.0"

func loadConfig() Config {
	token := os.Getenv("ADMIN_TOKEN")
	cfg := Config{
		Port:                 envInt("PORT", 4100),
		DataDir:              envStr("RELAY_DATA_DIR", "data"),
		AdminToken:           token,
		MaxEventBytes:        envInt64("MAX_EVENT_BYTES", 256*1024),
		MaxOwnerBytes:        envInt64("MAX_OWNER_BYTES", 1024*1024*1024),
		// Global storage ceiling across all owners. 0 = disabled (per-owner
		// quotas only). Set it to your disk size minus headroom so a few full
		// owners can't fill the volume and fail writes for every tenant.
		MaxTotalBytes:    envInt64("MAX_TOTAL_BYTES", 0),
		MaxEventsPerPush: envInt("MAX_EVENTS_PER_PUSH", 1000),
		MaxEventsPerPull:     envInt("MAX_EVENTS_PER_PULL", 5000),
		DefaultEventsPerPull: envInt("DEFAULT_EVENTS_PER_PULL", 1000),
		// Byte ceiling on a single pull page, independent of the count cap: at
		// 256 KiB/event the count cap alone admits a multi-hundred-MiB page.
		MaxPullBytes: envInt64("MAX_PULL_BYTES", 8*1024*1024),
		MaxStreamsPerCompact: envInt("MAX_STREAMS_PER_COMPACT", 1000),
		MaxBlobBytes:         envInt64("MAX_BLOB_BYTES", 8*1024*1024),
		CompactionInterval:   resolveCompactionInterval(),
		MaxOwners:            envInt("MAX_OWNERS", 100000),
		RateLimitEnabled:     envBool("RATE_LIMIT_ENABLED", true),
		RateLimitAPI:         envInt("RATE_LIMIT_API", 120),
		RateLimitWrite:       envInt("RATE_LIMIT_WRITE", 60),
		// Per-IP owner-creation budget, mirroring the Cloudflare relay's
		// CREATE_LIMITER. Minting a new owner is the only way to grow the fleet,
		// so it's the costliest path to leave unbounded.
		RateLimitCreate: envInt("RATE_LIMIT_CREATE", 5),
		// Off by default: honor CF-Connecting-IP / X-Forwarded-For only behind a
		// proxy you trust to set them. Directly exposed, those headers are
		// client-forgeable, so the per-IP limiters must key on the real socket
		// peer instead. Set TRUST_PROXY_HEADERS=1 when deploying behind
		// Cloudflare or a reverse proxy that overwrites (not appends) them.
		TrustProxyHeaders: envBool("TRUST_PROXY_HEADERS", false),
	}
	if token != "" {
		cfg.AdminBase = resolveAdminBase(token)
	}
	return cfg
}

// The dashboard lives at a secret base path, not /admin. By default it's derived
// from the token (unguessable without the secret, zero extra config); override
// with ADMIN_PATH.
func resolveAdminBase(token string) string {
	if explicit := strings.TrimSpace(os.Getenv("ADMIN_PATH")); explicit != "" {
		return "/" + strings.Trim(explicit, "/")
	}
	sum := sha256.Sum256([]byte(token))
	return "/ops-" + hex.EncodeToString(sum[:])[:16]
}

func resolveCompactionInterval() time.Duration {
	raw := os.Getenv("COMPACTION_INTERVAL_MS")
	if raw == "0" {
		return 0
	}
	def := 6 * time.Hour
	if raw == "" {
		return def
	}
	ms, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || ms <= 0 {
		return def
	}
	return time.Duration(ms) * time.Millisecond
}

func main() {
	cfg := loadConfig()

	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		log.Fatalf("create data dir: %v", err)
	}

	st, err := openStore(cfg.DataDir)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.close()
	st.maxOwners = cfg.MaxOwners
	if err := st.migrate(); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	if cfg.AdminToken != "" {
		go adminSweepLoop()
	}

	// Periodically compact the log so the DB stops growing with superseded events.
	if cfg.CompactionInterval > 0 {
		go func() {
			ticker := time.NewTicker(cfg.CompactionInterval)
			defer ticker.Stop()
			for range ticker.C {
				result, err := st.compactLog()
				if err != nil {
					log.Printf("compaction failed: %v", err)
					continue
				}
				setCompactionInfo(result)
				if result.DeletedEvents > 0 {
					log.Printf("compaction: removed %d superseded events, reclaimed %d bytes in %dms",
						result.DeletedEvents, result.ReclaimedBytes, result.DurationMs)
				}
			}
		}()
	}

	initRateLimiters(cfg)
	// metrics outermost so 429s are counted; then the per-IP rate limit; then
	// routes. The counters are only readable through the admin dashboard, so
	// skip the per-request lock entirely when admin is off (the default).
	handler := withRateLimit(routeHandler(cfg, st))
	if cfg.AdminToken != "" {
		handler = withMetrics(cfg, handler)
	}
	server := &http.Server{
		Addr:    ":" + strconv.Itoa(cfg.Port),
		Handler: handler,
		// ReadHeaderTimeout bounds the header phase; ReadTimeout bounds the
		// whole request (headers + body), so a client can't hold a connection
		// open by dribbling the body one byte at a time (slowloris) after the
		// headers land. 120s is generous enough for a large but legitimate
		// push on a slow link, while still capping a stalled connection.
		// IdleTimeout closes hoarded keep-alive connections that never send
		// another request. A fixed write-side deadline is intentionally
		// omitted — it would truncate large pull/blob responses on slow
		// clients.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       120 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	log.Printf("Secure local-first relay listening on http://localhost:%d", cfg.Port)
	if cfg.AdminToken != "" {
		// Logged server-side only (journalctl), so the operator can find the
		// secret path without it being exposed anywhere public.
		log.Printf("Ops dashboard: http://localhost:%d%s", cfg.Port, cfg.AdminBase)
	}
	if cfg.CompactionInterval > 0 {
		log.Printf("Log compaction every %dm", int(cfg.CompactionInterval.Minutes()))
	}

	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}

// SHA-256 -> base64url (no padding). Matches @simplysync/protocol so blob
// content-hash verification agrees with the client.
func sha256B64(b []byte) string {
	sum := sha256.Sum256(b)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func envInt64(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func dbPath(dataDir string) string {
	return filepath.Join(dataDir, "relay.db")
}
