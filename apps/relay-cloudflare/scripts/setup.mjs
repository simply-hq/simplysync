#!/usr/bin/env node
// One-shot setup for the Cloudflare relay:
//
//   npm run setup      (or: bun run setup)
//
// It signs in when needed, creates the D1 database and R2 bucket, wires the
// database id into wrangler.toml, applies the schema, and deploys the Worker.
// Safe to re-run: existing resources are reused, not duplicated.

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { deployedRelayUrl, verifyRelayHealth } from "./verify.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOML = join(ROOT, "wrangler.toml");
const DB = "sbt-relay";
const BUCKET = "sbt-relay-blobs";

// Interactive call: let wrangler talk to the terminal (prompts, progress).
const wrangler = (args, environment = {}) =>
  execFileSync("wrangler", args, {
    cwd: ROOT,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
// Captured call: return wrangler's stdout as a string.
const wranglerOut = (args) =>
  execFileSync("wrangler", args, { cwd: ROOT, encoding: "utf8" });

const step = (msg) => console.log(`\n\x1b[1m▸ ${msg}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);

// 0. Sign in when needed.
step("Checking you are signed in to Cloudflare…");
try {
  wranglerOut(["whoami"]);
  ok("Signed in.");
} catch {
  step("Opening Cloudflare sign-in…");
  try {
    wrangler(["login"]);
    wranglerOut(["whoami"]);
    ok("Signed in.");
  } catch {
    console.error("\nCloudflare sign-in did not complete. No resources were created.\n");
    process.exit(1);
  }
}

// 1. Create the D1 database (idempotent).
step(`Creating the database (${DB})…`);
try {
  wrangler(["d1", "create", DB]);
  ok("Database created.");
} catch {
  ok("A database with that name already exists — reusing it.");
}

// 2. Wire its id into wrangler.toml.
step("Connecting the database to your sync relay…");
const list = JSON.parse(wranglerOut(["d1", "list", "--json"]));
const db = list.find((d) => d.name === DB);
if (!db || !db.uuid) {
  console.error(`\nCould not find the "${DB}" database. Aborting.\n`);
  process.exit(1);
}
let cfg = readFileSync(TOML, "utf8");
if (/database_id = ".*"/.test(cfg)) {
  cfg = cfg.replace(/database_id = ".*"/, `database_id = "${db.uuid}"`);
} else {
  cfg = cfg.replace(
    /(database_name = ".*"\n)/,
    `$1database_id = "${db.uuid}"\n`,
  );
}
writeFileSync(TOML, cfg);
ok(`Linked database id ${db.uuid}.`);

// 3. Create the R2 bucket for encrypted blobs (idempotent).
step(`Creating the blob storage bucket (${BUCKET})…`);
try {
  wrangler(["r2", "bucket", "create", BUCKET]);
  ok("Bucket created.");
} catch {
  ok("A bucket with that name already exists — reusing it.");
}

// 4. Apply the database schema.
step("Setting up the database tables…");
wrangler(["d1", "migrations", "apply", DB, "--remote"]);
ok("Tables ready.");

// 5. Deploy.
step("Deploying your sync relay…");
const outputDirectory = mkdtempSync(join(tmpdir(), "simplysync-wrangler-output-"));
const outputPath = join(outputDirectory, "deploy.jsonl");
let relayUrl;
try {
  wrangler(["deploy"], { WRANGLER_OUTPUT_FILE_PATH: outputPath });
  relayUrl = deployedRelayUrl(readFileSync(outputPath, "utf8"));
} finally {
  rmSync(outputDirectory, { force: true, recursive: true });
}

// 6. Prove the deployed Worker is reachable before handing it off.
step("Verifying the relay health endpoint…");
const healthUrl = await verifyRelayHealth(relayUrl);
ok(`Healthy at ${healthUrl}`);

console.log(
  "\n\x1b[1m✅ Your sync relay is live.\x1b[0m\n\n" +
    `Relay URL: ${relayUrl}\n\n` +
    "Paste this URL into your app's Relay URL setting. Restore the same\n" +
    "recovery key on a second device to verify end-to-end sync.\n\n" +
    "The relay's safety limits are already enabled. Cloudflare usage\n" +
    "notifications are an optional final step.\n",
);
