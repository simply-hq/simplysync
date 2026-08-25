// The seam the relay contract hangs off: one descriptor per implementation, so
// an assertion is written once and proven of every relay rather than of
// whichever one the suite happened to boot.
//
// Both relays name their tunables identically — Go reads them as environment,
// Cloudflare as Worker `[vars]` — so a profile is a plain record of names and
// only the launcher differs. Where an implementation genuinely cannot be
// configured the same way (Cloudflare's rate limits are bindings, not vars),
// the descriptor carries the number instead of the test branching on a name. A
// contract test may read an adapter's numbers; it must never read its name.

import { isGoAvailable, launchRelay, type LaunchedRelay } from "./launch-relay";
import {
  isWranglerAvailable,
  launchCloudflareRelay,
} from "./launch-cloudflare";

/** Small enough that a handful of events or blob chunks reaches the cap. */
const TINY_OWNER_QUOTA_BYTES = 4096;
/** Small enough that an oversized blob PUT is a few KB, not the 8 MiB default. */
export const TINY_BLOB_BYTES = 1024;

/** Go's limiter budgets are plain config, so they can be made trivial. */
const GO_LIMITS = { api: 3, write: 2 } as const;
/**
 * Cloudflare's are rate-limit *bindings* (apps/relay-cloudflare/wrangler.toml),
 * which `wrangler dev` cannot override per instance — so the contract exhausts
 * the real budgets instead. Keep these two numbers in sync with that file.
 */
const CLOUDFLARE_LIMITS = { api: 120, write: 60 } as const;

/**
 * The relay configurations the contract needs. Every rejection a client can
 * provoke has a ceiling behind it, and the default ceilings are far too high to
 * reach over HTTP in a test — so each is booted once, small.
 */
const PROFILE_VARS = {
  /** Default tunables: everything that isn't about a ceiling runs here. */
  base: {},
  /** Owner byte quota + blob chunk ceiling, both reachable in a few requests. */
  tinyQuota: {
    MAX_OWNER_BYTES: String(TINY_OWNER_QUOTA_BYTES),
    MAX_BLOB_BYTES: String(TINY_BLOB_BYTES),
  },
  /** The global fleet cap: two owners, then the relay is full. */
  ownerCap: { MAX_OWNERS: "2" },
  /** A push body ceiling small enough to exceed with a few KB of junk. */
  tinyBody: { MAX_EVENT_BYTES: "1024", MAX_EVENTS_PER_PUSH: "2" },
} as const;

/**
 * The two rate limits, one relay each: with both budgets tiny on one instance
 * the per-IP limiter answers first and the per-owner one is never reached.
 * Null for an implementation whose budgets can't be shrunk — its contract runs
 * against the base relay and the real numbers in `limits`.
 */
const GO_LIMIT_VARS = {
  apiLimited: {
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_API: String(GO_LIMITS.api),
  },
  writeLimited: {
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_WRITE: String(GO_LIMITS.write),
  },
} as const;

type ProfileName = keyof typeof PROFILE_VARS;
type LimitProfileName = keyof typeof GO_LIMIT_VARS;

/** Every profile, plus the relays that enforce this adapter's rate limits. */
export type BootedRelays = Record<ProfileName | LimitProfileName, LaunchedRelay>;

export interface RelayAdapter {
  readonly name: string;
  /** What the limited relays enforce: requests per IP, writes per owner. */
  readonly limits: { readonly api: number; readonly write: number };
  /** A fresh, empty relay of this implementation — the wipe-recovery path. */
  launchEmpty(): Promise<LaunchedRelay>;
  /** Boots every profile in parallel. */
  boot(): Promise<BootedRelays>;
}

async function bootProfiles(
  launch: (vars: Record<string, string>) => Promise<LaunchedRelay>,
  limitVars: typeof GO_LIMIT_VARS | null,
): Promise<BootedRelays> {
  const names = Object.keys(PROFILE_VARS) as ProfileName[];
  const limitNames = Object.keys(GO_LIMIT_VARS) as LimitProfileName[];
  const launched = await Promise.all([
    ...names.map((name) => launch(PROFILE_VARS[name])),
    ...limitNames.map((name) =>
      limitVars ? launch(limitVars[name]) : null,
    ),
  ]);
  const booted = Object.fromEntries(
    names.map((name, i) => [name, launched[i]!]),
  ) as BootedRelays;
  limitNames.forEach((name, i) => {
    booted[name] = launched[names.length + i] ?? booted.base;
  });
  return booted;
}

/**
 * Terminates every relay a boot() produced. kill() is idempotent, so an aliased
 * instance (Cloudflare's limited relays ARE its base one) is safe to list twice.
 */
export async function killAll(relays: BootedRelays | undefined): Promise<void> {
  if (!relays) return;
  await Promise.all(Object.values(relays).map((relay) => relay.kill()));
}

const go: RelayAdapter = {
  name: "go",
  limits: GO_LIMITS,
  launchEmpty: () => launchRelay({ RATE_LIMIT_ENABLED: "false" }),
  boot: () =>
    bootProfiles(
      // Off everywhere but the two rate-limit profiles: a shared budget across
      // hundreds of contract requests would 429 assertions that are about
      // something else entirely.
      (vars) => launchRelay({ RATE_LIMIT_ENABLED: "false", ...vars }),
      GO_LIMIT_VARS,
    ),
};

const cloudflare: RelayAdapter = {
  name: "cloudflare",
  limits: CLOUDFLARE_LIMITS,
  launchEmpty: () => launchCloudflareRelay(),
  boot: () => bootProfiles(launchCloudflareRelay, null),
};

if (!isGoAvailable()) {
  throw new Error("[relay-contract] `go` was not found on PATH");
}

// Cloudflare needs wrangler, which a machine that only has Go won't have. That
// is a fine reason to skip locally and never a reason to skip in CI: a suite
// whose whole point is asserting the contract of BOTH relays reporting green
// after checking one is worse than no suite. RELAY_REQUIRE_CLOUDFLARE=1 (set by
// .github/workflows/ci.yml, declared in turbo.json so it survives turbo's
// strict env mode) turns the skip back into the failure it is.
const REQUIRE_CLOUDFLARE = process.env.RELAY_REQUIRE_CLOUDFLARE === "1";
export const CLOUDFLARE_AVAILABLE = isWranglerAvailable();

if (REQUIRE_CLOUDFLARE && !CLOUDFLARE_AVAILABLE) {
  throw new Error(
    "[relay-contract] RELAY_REQUIRE_CLOUDFLARE=1 but wrangler was not found — " +
      "the Cloudflare relay cannot be booted, so the contract would only be " +
      "asserted of Go. Run `bun install` in apps/relay-cloudflare.",
  );
}
if (!CLOUDFLARE_AVAILABLE) {
  console.warn(
    "[relay-contract] wrangler not found: asserting the contract of Go ONLY. " +
      "Set RELAY_REQUIRE_CLOUDFLARE=1 to make this a failure.",
  );
}

/** Every relay implementation this machine can drive. */
export function implementations(): RelayAdapter[] {
  return CLOUDFLARE_AVAILABLE ? [go, cloudflare] : [go];
}
