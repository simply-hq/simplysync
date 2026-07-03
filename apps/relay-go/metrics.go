package main

import (
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

// In-process operational metrics: request counters, a sampled ring buffer for
// usage trends, and system/disk probes for capacity planning. All in memory
// (history resets on restart) — enough to spot growth and project disk runway.

var (
	metricsMu      sync.Mutex
	startedAt      = time.Now()
	totalRequests  int64
	totalErrors    int64
	byEndpoint     = map[string]int64{}
	byStatus       = map[string]int64{}
	samples        []sample
	maxSamples     = 1440 // 24h at 60s
	lastCompaction *CompactionResult
)

type sample struct {
	t             int64
	owners        int64
	events        int64
	blobs         int64
	storedBytes   int64
	dbBytes       int64
	diskFreeBytes uint64
	memUsedBytes  uint64
	load1         float64
	requests      int64
}

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

func startSampler(st *store, dataDir string) {
	go func() {
		collect(st, dataDir) // initial sample
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			collect(st, dataDir)
		}
	}()
}

func collect(st *store, dataDir string) {
	agg, err := st.aggregates()
	if err != nil {
		return
	}
	_, free := diskInfo(dataDir)
	_, memFree := memInfo()
	memTotal, _ := memInfo()
	s := sample{
		t:             time.Now().UnixMilli(),
		owners:        agg.Owners,
		events:        agg.Events,
		blobs:         agg.Blobs,
		storedBytes:   agg.StoredBytes,
		dbBytes:       dbBytes(dataDir),
		diskFreeBytes: free,
		memUsedBytes:  saturatingSub(memTotal, memFree),
		load1:         loadAvg()[0],
	}
	metricsMu.Lock()
	s.requests = totalRequests
	samples = append(samples, s)
	if len(samples) > maxSamples {
		samples = samples[len(samples)-maxSamples:]
	}
	metricsMu.Unlock()
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

func growthPerDay(pick func(sample) float64) float64 {
	if len(samples) < 2 {
		return 0
	}
	first, last := samples[0], samples[len(samples)-1]
	days := float64(last.t-first.t) / 86_400_000
	if days <= 0 {
		return 0
	}
	return (pick(last) - pick(first)) / days
}

func requestsPerMin() float64 {
	if len(samples) >= 2 {
		last := samples[len(samples)-1]
		cutoff := last.t - 10*60_000
		ref := samples[0]
		for _, s := range samples {
			if s.t >= cutoff {
				ref = s
				break
			}
		}
		minutes := float64(last.t-ref.t) / 60_000
		if minutes > 0 {
			return float64(last.requests-ref.requests) / minutes
		}
	}
	lifetimeMin := time.Since(startedAt).Minutes()
	if lifetimeMin > 0 {
		return float64(totalRequests) / lifetimeMin
	}
	return 0
}

func downsample(n int) []sample {
	if len(samples) <= n {
		out := make([]sample, len(samples))
		copy(out, samples)
		return out
	}
	step := float64(len(samples)) / float64(n)
	out := make([]sample, 0, n+1)
	for i := 0; i < n; i++ {
		out = append(out, samples[int(float64(i)*step)])
	}
	out = append(out, samples[len(samples)-1])
	return out
}

// --- /admin/stats payload (camelCase JSON the dashboard reads) ---------------

type RelayStats struct {
	Service     string         `json:"service"`
	Now         int64          `json:"now"`
	StartedAt   int64          `json:"startedAt"`
	UptimeMs    int64          `json:"uptimeMs"`
	System      systemStats    `json:"system"`
	Storage     storageStats   `json:"storage"`
	Traffic     trafficStats   `json:"traffic"`
	Capacity    capacityStats  `json:"capacity"`
	History     []historyPoint `json:"history"`
	Maintenance maintenance    `json:"maintenance"`
}

type systemStats struct {
	Hostname string     `json:"hostname"`
	CPUs     int        `json:"cpus"`
	Load     [3]float64 `json:"load"`
	Mem      resStat    `json:"mem"`
	Disk     resStat    `json:"disk"`
}

type resStat struct {
	Total   uint64  `json:"total"`
	Free    uint64  `json:"free"`
	Used    uint64  `json:"used"`
	UsedPct float64 `json:"usedPct"`
}

type storageStats struct {
	Owners          int64        `json:"owners"`
	Events          int64        `json:"events"`
	Blobs           int64        `json:"blobs"`
	StoredBytes     int64        `json:"storedBytes"`
	DBBytes         int64        `json:"dbBytes"`
	AvgBytesPerOwner float64     `json:"avgBytesPerOwner"`
	TopOwners       []ownerUsage `json:"topOwners"`
}

type trafficStats struct {
	TotalRequests  int64            `json:"totalRequests"`
	TotalErrors    int64            `json:"totalErrors"`
	RequestsPerMin float64          `json:"requestsPerMin"`
	ByEndpoint     map[string]int64 `json:"byEndpoint"`
	ByStatus       map[string]int64 `json:"byStatus"`
}

type capacityStats struct {
	DiskUsedPct             float64  `json:"diskUsedPct"`
	MemUsedPct              float64  `json:"memUsedPct"`
	DBGrowthBytesPerDay     float64  `json:"dbGrowthBytesPerDay"`
	StoredGrowthBytesPerDay float64  `json:"storedGrowthBytesPerDay"`
	DiskRunwayDays          *float64 `json:"diskRunwayDays"`
	Warnings                []string `json:"warnings"`
}

type historyPoint struct {
	T             int64   `json:"t"`
	StoredBytes   int64   `json:"storedBytes"`
	DBBytes       int64   `json:"dbBytes"`
	DiskFreeBytes uint64  `json:"diskFreeBytes"`
	MemUsedBytes  uint64  `json:"memUsedBytes"`
	Load1         float64 `json:"load1"`
	Events        int64   `json:"events"`
	Owners        int64   `json:"owners"`
}

type maintenance struct {
	LastCompaction *CompactionResult `json:"lastCompaction"`
}

func buildStats(st *store, dataDir string) RelayStats {
	collect(st, dataDir) // refresh "now"

	metricsMu.Lock()
	defer metricsMu.Unlock()

	now := time.Now()
	diskTotal, diskFree := diskInfo(dataDir)
	memTotal, memFree := memInfo()
	memUsed := saturatingSub(memTotal, memFree)
	cpus := runtime.NumCPU()
	load := loadAvg()

	agg, _ := st.aggregates()
	dbb := dbBytes(dataDir)
	tops, _ := st.topOwners(10)

	diskUsed := saturatingSub(diskTotal, diskFree)
	diskUsedPct := ratio(diskUsed, diskTotal)
	memUsedPct := ratio(memUsed, memTotal)

	dbGrowth := growthPerDay(func(s sample) float64 { return float64(s.dbBytes) })
	storedGrowth := growthPerDay(func(s sample) float64 { return float64(s.storedBytes) })

	var runway *float64
	if dbGrowth > 0 {
		r := float64(diskFree) / dbGrowth
		runway = &r
	}

	warnings := []string{}
	if diskUsedPct > 0.85 {
		warnings = append(warnings, "Disk "+pct0(diskUsedPct)+" full")
	}
	if runway != nil && *runway < 30 {
		warnings = append(warnings, "Disk projected full in ~"+itoa(int64(*runway))+" days")
	}
	if memUsedPct > 0.9 {
		warnings = append(warnings, "Memory "+pct0(memUsedPct)+" used")
	}
	if load[0] > float64(cpus) {
		warnings = append(warnings, "Load "+f2(load[0])+" exceeds "+itoa(int64(cpus))+" CPU(s)")
	}

	var avgPerOwner float64
	if agg.Owners > 0 {
		avgPerOwner = float64(agg.StoredBytes) / float64(agg.Owners)
	}

	hist := downsample(120)
	points := make([]historyPoint, 0, len(hist))
	for _, s := range hist {
		points = append(points, historyPoint{
			T: s.t, StoredBytes: s.storedBytes, DBBytes: s.dbBytes,
			DiskFreeBytes: s.diskFreeBytes, MemUsedBytes: s.memUsedBytes,
			Load1: s.load1, Events: s.events, Owners: s.owners,
		})
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

	return RelayStats{
		Service:   "simplysync-relay",
		Now:       now.UnixMilli(),
		StartedAt: startedAt.UnixMilli(),
		UptimeMs:  now.Sub(startedAt).Milliseconds(),
		System: systemStats{
			Hostname: host, CPUs: cpus, Load: load,
			Mem:  resStat{memTotal, memFree, memUsed, memUsedPct},
			Disk: resStat{diskTotal, diskFree, diskUsed, diskUsedPct},
		},
		Storage: storageStats{
			Owners: agg.Owners, Events: agg.Events, Blobs: agg.Blobs,
			StoredBytes: agg.StoredBytes, DBBytes: dbb,
			AvgBytesPerOwner: avgPerOwner, TopOwners: tops,
		},
		Traffic: trafficStats{
			TotalRequests: totalRequests, TotalErrors: totalErrors,
			RequestsPerMin: requestsPerMin(), ByEndpoint: endpoints, ByStatus: statuses,
		},
		Capacity: capacityStats{
			DiskUsedPct: diskUsedPct, MemUsedPct: memUsedPct,
			DBGrowthBytesPerDay: dbGrowth, StoredGrowthBytesPerDay: storedGrowth,
			DiskRunwayDays: runway, Warnings: warnings,
		},
		History:     points,
		Maintenance: maintenance{LastCompaction: lastCompaction},
	}
}

func saturatingSub(a, b uint64) uint64 {
	if a < b {
		return 0
	}
	return a - b
}

func ratio(part, whole uint64) float64 {
	if whole == 0 {
		return 0
	}
	return float64(part) / float64(whole)
}
