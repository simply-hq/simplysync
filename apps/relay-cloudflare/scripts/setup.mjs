#!/usr/bin/env node
// One-shot setup for the Cloudflare relay. Run it after `wrangler login`:
//
//   npm run setup      (or: bun run setup)
//
// It creates the D1 database and R2 bucket, wires the database id into
// wrangler.toml, applies the schema, and deploys the Worker. Safe to re-run:
// existing resources are reused, not duplicated.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOML = join(ROOT, "wrangler.toml");
const DB = "simplysync-relay";
const BUCKET = "simplysync-relay-blobs";

// Interactive call: let wrangler talk to the terminal (prompts, progress).
const wrangler = (args) =>
  execFileSync("wrangler", args, { cwd: ROOT, stdio: "inherit" });
// Captured call: return wrangler's stdout as a string.
const wranglerOut = (args) =>
  execFileSync("wrangler", args, { cwd: ROOT, encoding: "utf8" });

const step = (msg) => console.log(`\n\x1b[1m▸ ${msg}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);

// 0. Must be logged in.
step("Checking you are signed in to Cloudflare…");
try {
  wranglerOut(["whoami"]);
  ok("Signed in.");
} catch {
  console.error(
    "\nYou are not signed in yet. Run this first, then try again:\n\n  npx wrangler login\n",
  );
  process.exit(1);
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
step("Connecting the database to your sync server…");
const list = JSON.parse(wranglerOut(["d1", "list", "--json"]));
const db = list.find((d) => d.name === DB);
if (!db || !db.uuid) {
  console.error(`\nCould not find the "${DB}" database. Aborting.\n`);
  process.exit(1);
}
let cfg = readFileSync(TOML, "utf8");
cfg = cfg.replace(/database_id = ".*"/, `database_id = "${db.uuid}"`);
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
step("Deploying your sync server…");
wrangler(["deploy"]);

console.log(
  "\n\x1b[1m✅ Your sync server is live.\x1b[0m\n\n" +
    "Copy the https://… URL printed just above, then in Simply Finance open\n" +
    "Settings › Sync Servers and paste it in.\n\n" +
    "One recommended follow-up: in the Cloudflare dashboard, turn on billing\n" +
    "alerts and add a rate-limit rule so a stranger can never run up your bill.\n" +
    "See the guide for the two-minute version.\n",
);
