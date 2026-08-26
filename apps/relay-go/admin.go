package main

import (
	"crypto/subtle"
	"net/http"
	"sync"
	"time"
)

// Brute-force lockout for the admin token: too many failed attempts from one IP
// trip a cooldown, so the token can't be hammered even if the secret path leaks.
const (
	adminMaxFails = 10
	adminLockMs   = 5 * 60 * 1000
)

// dashboardCSP is defense-in-depth for the ops dashboard: escaping (see
// admin_page.go) is the primary XSS defense, but this blocks exfiltration to
// external hosts and injected <script src>/external loads even if a future
// dashboard field forgets to escape. 'unsafe-inline' is required because the
// dashboard's script/styles are inline with no external file to reference.
const dashboardCSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"

var (
	adminMu    sync.Mutex
	adminFails = map[string]*failRec{}
)

type failRec struct {
	count int
	until int64 // epoch ms
	seen  int64 // epoch ms of the last failure, so idle records can be swept
}

func adminLocked(ip string) bool {
	adminMu.Lock()
	defer adminMu.Unlock()
	rec := adminFails[ip]
	return rec != nil && rec.until > time.Now().UnixMilli()
}

func adminRecordFail(ip string) {
	adminMu.Lock()
	defer adminMu.Unlock()
	rec := adminFails[ip]
	if rec == nil {
		rec = &failRec{}
		adminFails[ip] = rec
	}
	rec.seen = time.Now().UnixMilli()
	rec.count++
	if rec.count >= adminMaxFails {
		rec.until = rec.seen + adminLockMs
		rec.count = 0
	}
}

// adminSweep drops records whose lockout has expired and whose last failure is
// older than the lock window, so the map stays bounded to recently-active IPs
// instead of growing once per distinct source ever seen. Mirrors the rate
// limiter's sweepLoop.
func adminSweep() {
	now := time.Now().UnixMilli()
	adminMu.Lock()
	defer adminMu.Unlock()
	for ip, rec := range adminFails {
		if rec.until <= now && rec.seen <= now-adminLockMs {
			delete(adminFails, ip)
		}
	}
}

func adminSweepLoop() {
	for {
		time.Sleep(adminLockMs * time.Millisecond)
		adminSweep()
	}
}

func adminClearFail(ip string) {
	adminMu.Lock()
	defer adminMu.Unlock()
	delete(adminFails, ip)
}

// adminAuth: lockout check + constant-time token compare.
func adminAuth(cfg Config, w http.ResponseWriter, r *http.Request) bool {
	ip := clientIP(r)
	if adminLocked(ip) {
		writeJSON(w, http.StatusTooManyRequests, errBody("Too many attempts"))
		return false
	}
	token := bearerToken(r)
	if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(cfg.AdminToken)) != 1 {
		adminRecordFail(ip)
		writeJSON(w, http.StatusUnauthorized, errBody("Unauthorized"))
		return false
	}
	adminClearFail(ip)
	return true
}

func handleAdmin(cfg Config, st *store, w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	// The dashboard shell is served (it holds no data); it prompts for the token
	// client-side and calls <base>/stats with it.
	if path == cfg.AdminBase && r.Method == http.MethodGet {
		writeCORS(w)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", dashboardCSP)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(adminPage))
		return
	}

	if path == cfg.AdminBase+"/stats" && r.Method == http.MethodGet {
		if !adminAuth(cfg, w, r) {
			return
		}
		writeJSON(w, http.StatusOK, buildStats(st, cfg.DataDir))
		return
	}

	if path == cfg.AdminBase+"/compact" && r.Method == http.MethodPost {
		if !adminAuth(cfg, w, r) {
			return
		}
		result, err := st.compactLog()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errBody("Compaction failed"))
			return
		}
		setCompactionInfo(result)
		writeJSON(w, http.StatusOK, result)
		return
	}

	writeJSON(w, http.StatusMethodNotAllowed, errBody("Method not allowed"))
}
