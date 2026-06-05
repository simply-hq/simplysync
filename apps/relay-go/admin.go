package main

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Brute-force lockout for the admin token: too many failed attempts from one IP
// trip a cooldown, so the token can't be hammered even if the secret path leaks.
const (
	adminMaxFails = 10
	adminLockMs   = 5 * 60 * 1000
)

var (
	adminMu    sync.Mutex
	adminFails = map[string]*failRec{}
)

type failRec struct {
	count int
	until int64 // epoch ms
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
	rec.count++
	if rec.count >= adminMaxFails {
		rec.until = time.Now().UnixMilli() + adminLockMs
		rec.count = 0
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

// --- small format helpers used in warning strings ---------------------------

func pct0(x float64) string { return fmt.Sprintf("%.0f%%", x*100) }
func itoa(n int64) string   { return strconv.FormatInt(n, 10) }
func f2(x float64) string   { return fmt.Sprintf("%.2f", x) }
