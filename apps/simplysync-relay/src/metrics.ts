// Operational metrics for the relay: request counters, a sampled ring buffer
// for usage trends, and system/disk probes for capacity planning. Everything is
// in-process and dependency-free; history is in memory (lost on restart), which
// is enough to spot growth trends and project when a single box runs out of
// disk. For longer retention, scrape /admin/stats into your own store.

import os from "node:os";
import { statSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

const startedAt = Date.now();
let totalRequests = 0;
let totalErrors = 0;
const byEndpoint: Record<string, number> = {};
const byStatus: Record<string, number> = {};

// Last log-compaction result, surfaced in /admin/stats for ops visibility.
let lastCompaction: unknown = null;
export function setCompactionInfo(info: unknown): void {
  lastCompaction = info;
}

/** Records one handled request. `label` is a low-cardinality route label. */
export function recordRequest(label: string, status: number): void {
  totalRequests += 1;
  byEndpoint[label] = (byEndpoint[label] ?? 0) + 1;
  const bucket = `${Math.floor(status / 100)}xx`;
  byStatus[bucket] = (byStatus[bucket] ?? 0) + 1;
  if (status >= 500) totalErrors += 1;
}

/** Collapses dynamic path segments so per-endpoint counts stay bounded. */
export function routeLabel(method: string, pathname: string): string {
  if (pathname.startsWith("/v1/blobs/")) return `${method} /v1/blobs/:hash`;
  return `${method} ${pathname}`;
}

interface Sample {
  t: number;
  owners: number;
  events: number;
  blobs: number;
  storedBytes: number;
  dbBytes: number;
  diskFreeBytes: number;
  memUsedBytes: number;
  load1: number;
  requests: number;
}

let samples: Sample[] = [];
let maxSamples = 1440; // 24h at 60s
let timer: ReturnType<typeof setInterval> | null = null;

/** Starts periodic sampling. Safe to call once at boot. */
export function startSampler(
  db: Database,
  dataDir: string,
  { intervalMs = 60_000, keep = 1440 }: { intervalMs?: number; keep?: number } = {},
): void {
  maxSamples = keep;
  const tick = (): void => {
    try {
      samples.push(collect(db, dataDir));
      if (samples.length > maxSamples) samples = samples.slice(-maxSamples);
    } catch (error) {
      console.error("metrics sample failed", error);
    }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  // Don't keep the event loop alive just for sampling.
  (timer as { unref?: () => void }).unref?.();
}

interface StorageAggregates {
  owners: number;
  events: number;
  blobs: number;
  storedBytes: number;
}

let aggQuery: ReturnType<Database["query"]> | null = null;
function storageAggregates(db: Database): StorageAggregates {
  // One round-trip for all four aggregates.
  aggQuery ??= db.query(`
    select
      (select count(*) from owners) as owners,
      (select coalesce(sum(stored_bytes), 0) from owners) as storedBytes,
      (select count(*) from events) as events,
      (select count(*) from blobs) as blobs
  `);
  const row = aggQuery.get() as {
    owners: number;
    storedBytes: number;
    events: number;
    blobs: number;
  };
  return {
    owners: row.owners,
    events: row.events,
    blobs: row.blobs,
    storedBytes: row.storedBytes,
  };
}

/** Top owners by stored bytes — finds the heavy users / runaway accounts. */
export function topOwners(
  db: Database,
  limit = 10,
): { ownerId: string; storedBytes: number }[] {
  const rows = db
    .query(
      `select owner_id as ownerId, stored_bytes as storedBytes
       from owners order by stored_bytes desc limit ?`,
    )
    .all(limit) as { ownerId: string; storedBytes: number }[];
  return rows;
}

function dbBytes(dataDir: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(join(dataDir, `relay.db${suffix}`)).size;
    } catch {
      // file may not exist (e.g. -wal between checkpoints)
    }
  }
  return total;
}

function diskInfo(dataDir: string): { total: number; free: number } {
  try {
    // statfsSync isn't in older @types/node; it exists in Bun/Node 18+.
    const st = (fs as unknown as {
      statfsSync: (p: string) => {
        bsize: number;
        blocks: number;
        bavail: number;
      };
    }).statfsSync(dataDir);
    return { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch {
    return { total: 0, free: 0 };
  }
}

function collect(db: Database, dataDir: string): Sample {
  const agg = storageAggregates(db);
  return {
    t: Date.now(),
    owners: agg.owners,
    events: agg.events,
    blobs: agg.blobs,
    storedBytes: agg.storedBytes,
    dbBytes: dbBytes(dataDir),
    diskFreeBytes: diskInfo(dataDir).free,
    memUsedBytes: os.totalmem() - os.freemem(),
    load1: os.loadavg()[0] ?? 0,
    requests: totalRequests,
  };
}

// Linear growth per day from the oldest to newest sample of a field.
function growthPerDay(pick: (s: Sample) => number): number {
  if (samples.length < 2) return 0;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const days = (last.t - first.t) / 86_400_000;
  if (days <= 0) return 0;
  return (pick(last) - pick(first)) / days;
}

// Requests/min from samples within the last ~window (falls back to lifetime avg).
function requestsPerMin(): number {
  if (samples.length >= 2) {
    const last = samples[samples.length - 1]!;
    // earliest sample no older than 10 minutes
    const cutoff = last.t - 10 * 60_000;
    const ref = samples.find((s) => s.t >= cutoff) ?? samples[0]!;
    const minutes = (last.t - ref.t) / 60_000;
    if (minutes > 0) return (last.requests - ref.requests) / minutes;
  }
  const lifetimeMin = (Date.now() - startedAt) / 60_000;
  return lifetimeMin > 0 ? totalRequests / lifetimeMin : 0;
}

// Evenly down-sample the ring buffer for compact sparklines.
function downsample(points: Sample[], n: number): Sample[] {
  if (points.length <= n) return points;
  const step = points.length / n;
  const out: Sample[] = [];
  for (let i = 0; i < n; i += 1) out.push(points[Math.floor(i * step)]!);
  out.push(points[points.length - 1]!);
  return out;
}

export interface RelayStats {
  service: string;
  now: number;
  startedAt: number;
  uptimeMs: number;
  system: {
    hostname: string;
    cpus: number;
    load: number[];
    mem: { total: number; free: number; used: number; usedPct: number };
    disk: { total: number; free: number; used: number; usedPct: number };
  };
  storage: {
    owners: number;
    events: number;
    blobs: number;
    storedBytes: number;
    dbBytes: number;
    avgBytesPerOwner: number;
    topOwners: { ownerId: string; storedBytes: number }[];
  };
  traffic: {
    totalRequests: number;
    totalErrors: number;
    requestsPerMin: number;
    byEndpoint: Record<string, number>;
    byStatus: Record<string, number>;
  };
  capacity: {
    diskUsedPct: number;
    memUsedPct: number;
    dbGrowthBytesPerDay: number;
    storedGrowthBytesPerDay: number;
    diskRunwayDays: number | null;
    warnings: string[];
  };
  maintenance: { lastCompaction: unknown };
  history: {
    t: number;
    storedBytes: number;
    dbBytes: number;
    diskFreeBytes: number;
    memUsedBytes: number;
    load1: number;
    events: number;
    owners: number;
  }[];
}

/** Assembles the full stats payload served at /admin/stats. */
export function buildStats(db: Database, dataDir: string): RelayStats {
  const now = collect(db, dataDir);
  const disk = diskInfo(dataDir);
  const memTotal = os.totalmem();
  const cpus = os.cpus().length || 1;

  const diskUsed = disk.total - disk.free;
  const diskUsedPct = disk.total > 0 ? diskUsed / disk.total : 0;
  const memUsedPct = memTotal > 0 ? now.memUsedBytes / memTotal : 0;

  const dbGrowthPerDay = growthPerDay((s) => s.dbBytes);
  const storedGrowthPerDay = growthPerDay((s) => s.storedBytes);
  const diskRunwayDays =
    dbGrowthPerDay > 0 ? disk.free / dbGrowthPerDay : null;

  const warnings: string[] = [];
  if (diskUsedPct > 0.85)
    warnings.push(`Disk ${(diskUsedPct * 100).toFixed(0)}% full`);
  if (diskRunwayDays !== null && diskRunwayDays < 30)
    warnings.push(`Disk projected full in ~${Math.floor(diskRunwayDays)} days`);
  if (memUsedPct > 0.9)
    warnings.push(`Memory ${(memUsedPct * 100).toFixed(0)}% used`);
  if (now.load1 > cpus)
    warnings.push(`Load ${now.load1.toFixed(2)} exceeds ${cpus} CPU(s)`);

  return {
    service: "simplysync-relay",
    now: now.t,
    startedAt,
    uptimeMs: now.t - startedAt,
    system: {
      hostname: os.hostname(),
      cpus,
      load: os.loadavg(),
      mem: {
        total: memTotal,
        free: os.freemem(),
        used: now.memUsedBytes,
        usedPct: memUsedPct,
      },
      disk: {
        total: disk.total,
        free: disk.free,
        used: diskUsed,
        usedPct: diskUsedPct,
      },
    },
    storage: {
      owners: now.owners,
      events: now.events,
      blobs: now.blobs,
      storedBytes: now.storedBytes,
      dbBytes: now.dbBytes,
      avgBytesPerOwner: now.owners > 0 ? now.storedBytes / now.owners : 0,
      topOwners: topOwners(db, 10),
    },
    traffic: {
      totalRequests,
      totalErrors,
      requestsPerMin: requestsPerMin(),
      byEndpoint: { ...byEndpoint },
      byStatus: { ...byStatus },
    },
    capacity: {
      diskUsedPct,
      memUsedPct,
      dbGrowthBytesPerDay: dbGrowthPerDay,
      storedGrowthBytesPerDay: storedGrowthPerDay,
      diskRunwayDays,
      warnings,
    },
    maintenance: { lastCompaction },
    history: downsample(samples, 120).map((s) => ({
      t: s.t,
      storedBytes: s.storedBytes,
      dbBytes: s.dbBytes,
      diskFreeBytes: s.diskFreeBytes,
      memUsedBytes: s.memUsedBytes,
      load1: s.load1,
      events: s.events,
      owners: s.owners,
    })),
  };
}
