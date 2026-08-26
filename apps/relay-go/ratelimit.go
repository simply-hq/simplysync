package main

import (
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Fixed-window in-memory rate limiter. Not distributed — each relay process
// keeps its own counters, which is the right fit for the single-VPS deploy
// this relay targets (the Cloudflare relay uses CF's edge rate-limit bindings
// instead). Keyed by an arbitrary string: an IP for the API limiter, an
// ownerId for the write limiter. A background sweep evicts expired keys so a
// flood of distinct keys can't grow the map without bound — that would itself
// be a memory-DoS vector.
type rateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	counts map[string]*windowCount
}

type windowCount struct {
	windowStart time.Time
	count       int
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{limit: limit, window: window, counts: map[string]*windowCount{}}
	go rl.sweepLoop()
	return rl
}

// allow reports whether a request for key is within budget, consuming one unit
// if so. False => the caller should reject with 429.
func (rl *rateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	wc := rl.counts[key]
	if wc == nil || now.Sub(wc.windowStart) >= rl.window {
		rl.counts[key] = &windowCount{windowStart: now, count: 1}
		return true
	}
	if wc.count >= rl.limit {
		return false
	}
	wc.count++
	return true
}

func (rl *rateLimiter) sweepLoop() {
	ticker := time.NewTicker(rl.window)
	defer ticker.Stop()
	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		for k, wc := range rl.counts {
			if now.Sub(wc.windowStart) >= rl.window {
				delete(rl.counts, k)
			}
		}
		rl.mu.Unlock()
	}
}

// Package-level limiters (mirrors metrics.go's package-level state). Nil until
// initRateLimiters runs; rateLimitOn gates every check so a disabled limiter
// is a no-op.
var (
	rateLimitOn       bool
	apiLimiter        *rateLimiter
	writeLimiter      *rateLimiter
	createLimiter     *rateLimiter
	trustProxyHeaders bool
)

func initRateLimiters(cfg Config) {
	// Independent of RateLimitEnabled: clientIP is used by every handler (auth
	// keying, admin lockout), so how it reads the peer address must be settled
	// even when the limiters themselves are off.
	trustProxyHeaders = cfg.TrustProxyHeaders
	rateLimitOn = cfg.RateLimitEnabled
	if !rateLimitOn {
		return
	}
	apiLimiter = newRateLimiter(cfg.RateLimitAPI, 10*time.Second)
	writeLimiter = newRateLimiter(cfg.RateLimitWrite, 10*time.Second)
	createLimiter = newRateLimiter(cfg.RateLimitCreate, time.Minute)
}

// withRateLimit is the per-IP front door. /health and CORS preflight stay free
// (mirrors the Cloudflare relay) so they can't be turned into an amplifier.
func withRateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !rateLimitOn || r.Method == http.MethodOptions || r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		if !apiLimiter.allow(clientIP(r)) {
			writeJSON(w, http.StatusTooManyRequests, errBody("Rate limited"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// envBool reads a boolean env var (default def). "1"/"true" => true.
func envBool(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	return v == "1" || strings.EqualFold(v, "true")
}
