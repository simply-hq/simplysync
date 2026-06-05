// Cloudflare-free, single-binary relay for the local-first sync protocol.
//
// Wire-compatible with apps/simplysync-relay (the Bun reference relay): same
// endpoints, same request/response shapes, same end-to-end-encrypted threat
// model (the relay only ever holds ciphertext + an owner id + an auth hash).
// Ported to Go so the production deploy is a single static binary with stable,
// low memory — no runtime to install on the box.
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

// Config is resolved from the environment at startup (same knobs as the Bun
// relay, plus COMPACTION_INTERVAL_MS).
type Config struct {
	Port                 int
	DataDir              string
	AdminToken           string
	AdminBase            string
	MaxEventBytes        int64
	MaxOwnerBytes        int64
	MaxEventsPerPush     int
	MaxEventsPerPull     int
	DefaultEventsPerPull int
	MaxBlobBytes         int64
	CompactionInterval   time.Duration
}

const blobPathPrefix = "/v1/blobs/"

func loadConfig() Config {
	token := os.Getenv("ADMIN_TOKEN")
	cfg := Config{
		Port:                 envInt("PORT", 4100),
		DataDir:              envStr("RELAY_DATA_DIR", "data"),
		AdminToken:           token,
		MaxEventBytes:        envInt64("MAX_EVENT_BYTES", 256*1024),
		MaxOwnerBytes:        envInt64("MAX_OWNER_BYTES", 1024*1024*1024),
		MaxEventsPerPush:     envInt("MAX_EVENTS_PER_PUSH", 1000),
		MaxEventsPerPull:     envInt("MAX_EVENTS_PER_PULL", 5000),
		DefaultEventsPerPull: envInt("DEFAULT_EVENTS_PER_PULL", 1000),
		MaxBlobBytes:         envInt64("MAX_BLOB_BYTES", 8*1024*1024),
		CompactionInterval:   resolveCompactionInterval(),
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
	if err := st.migrate(); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	// Sample storage/system stats for the dashboard (only when admin is on).
	if cfg.AdminToken != "" {
		startSampler(st, cfg.DataDir)
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

	// Optional LAN discovery (off unless MDNS_ENABLE is set).
	if mdnsEnabled() {
		if shutdownMDNS, err := startMDNS(cfg.Port); err != nil {
			log.Printf("mDNS: advertisement disabled (%v)", err)
		} else {
			defer shutdownMDNS()
		}
	}

	handler := withMetrics(cfg, routeHandler(cfg, st))
	server := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
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

// SHA-256 -> base64url (no padding). Matches @simplysync/core so blob
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
