package main

import (
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// In-process operational metrics for the admin dashboard: request counters and
// the relay-specific storage aggregates. All in memory (counters reset on
// restart). Host capacity (disk, memory, load) is the platform's job — `df`,
// `free`, and the process supervisor already report it.

var (
	metricsMu      sync.Mutex
	startedAt      = time.Now()
	totalRequests  int64
	totalErrors    int64
	byEndpoint     = map[string]int64{}
	byStatus       = map[string]int64{}
	lastCompaction *CompactionResult
)

func recordRequest(label string, status int) {
	metricsMu.Lock()
	defer metricsMu.Unlock()
	totalRequests++
	byEndpoint[label]++
	byStatus[bucket(status)]++
	if status >= 500 {
		totalErrors++
	}
}

func bucket(status int) string {
	switch {
	case status >= 500:
		return "5xx"
	case status >= 400:
		return "4xx"
	case status >= 300:
		return "3xx"
	default:
		return "2xx"
	}
}

func setCompactionInfo(c CompactionResult) {
	metricsMu.Lock()
	defer metricsMu.Unlock()
	cp := c
	lastCompaction = &cp
}

// routeLabel collapses dynamic + secret path segments so per-endpoint counts
// stay bounded and the secret admin path isn't echoed back. Any path that
// isn't one of the known, fixed routes collapses to a single "<other>"
// bucket — otherwise an unauthenticated client could plant an arbitrary
// string (later rendered unescaped in the ops dashboard) or grow byEndpoint
// without bound just by requesting distinct junk paths.
func routeLabel(cfg Config, method, path string) string {
	if strings.HasPrefix(path, blobPathPrefix) {
		return method + " /v1/blobs/:hash"
	}
	if cfg.AdminToken != "" {
		switch path {
		case cfg.AdminBase:
			return method + " /admin"
		case cfg.AdminBase + "/stats":
			return method + " /admin/stats"
		case cfg.AdminBase + "/compact":
			return method + " /admin/compact"
		}
	}
	switch path {
	case "/health":
		return method + " /health"
	case "/v1/events":
		return method + " /v1/events"
	case "/v1/streams/compact":
		return method + " /v1/streams/compact"
	case "/v1/usage":
		return method + " /v1/usage"
	case "/v1/status":
		return method + " /v1/status"
	}
	return method + " <other>"
}

// statusRecorder captures the response status for metrics.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func withMetrics(cfg Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		recordRequest(routeLabel(cfg, r.Method, r.URL.Path), rec.status)
	})
}

func dbBytes(dataDir string) int64 {
	var total int64
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if fi, err := os.Stat(dbPath(dataDir) + suffix); err == nil {
			total += fi.Size()
		}
	}
	return total
}

// buildStats is the /admin/stats payload (camelCase JSON the dashboard reads).
func buildStats(st *store, dataDir string) map[string]any {
	metricsMu.Lock()
	defer metricsMu.Unlock()

	now := time.Now()
	agg, _ := st.aggregates()
	tops, _ := st.topOwners(10)

	var avgPerOwner float64
	if agg.Owners > 0 {
		avgPerOwner = float64(agg.StoredBytes) / float64(agg.Owners)
	}
	var requestsPerMin float64
	if minutes := now.Sub(startedAt).Minutes(); minutes > 0 {
		requestsPerMin = float64(totalRequests) / minutes
	}

	endpoints := make(map[string]int64, len(byEndpoint))
	for k, v := range byEndpoint {
		endpoints[k] = v
	}
	statuses := make(map[string]int64, len(byStatus))
	for k, v := range byStatus {
		statuses[k] = v
	}

	host, _ := os.Hostname()

	return map[string]any{
		"service":   "sbt-local-first-relay",
		"now":       now.UnixMilli(),
		"startedAt": startedAt.UnixMilli(),
		"uptimeMs":  now.Sub(startedAt).Milliseconds(),
		"system":    map[string]any{"hostname": host},
		"storage": map[string]any{
			"owners":           agg.Owners,
			"events":           agg.Events,
			"blobs":            agg.Blobs,
			"storedBytes":      agg.StoredBytes,
			"dbBytes":          dbBytes(dataDir),
			"avgBytesPerOwner": avgPerOwner,
			"topOwners":        tops,
		},
		"traffic": map[string]any{
			"totalRequests":  totalRequests,
			"totalErrors":    totalErrors,
			"requestsPerMin": requestsPerMin,
			"byEndpoint":     endpoints,
			"byStatus":       statuses,
		},
		"maintenance": map[string]any{"lastCompaction": lastCompaction},
	}
}
