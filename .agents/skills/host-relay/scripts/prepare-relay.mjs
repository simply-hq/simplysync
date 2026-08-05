#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const source = resolve(process.argv[2] ?? "");
const required = [
  "package.json",
  "tsconfig.json",
  "wrangler.toml",
  "src",
  "migrations",
  "scripts",
];

if (!process.argv[2] || required.some((entry) => !existsSync(join(source, entry)))) {
  console.error(
    "Usage: prepare-relay.mjs <apps/relay-cloudflare>\n" +
      "The source must contain package.json, wrangler.toml, src, migrations, and scripts.",
  );
  process.exit(1);
}

const destination = mkdtempSync(join(tmpdir(), "simplysync-relay-"));
for (const entry of required) {
  cpSync(join(source, entry), join(destination, basename(entry)), {
    recursive: true,
  });
}

console.log(`RELAY_WORKDIR=${destination}`);
