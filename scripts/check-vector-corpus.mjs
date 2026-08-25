#!/usr/bin/env node
// The cross-language conformance corpus exists in three places: this repo's
// protocol package, the Swift verify harness, and the Kotlin test resources.
// The ports need their own copy because their CI clones are cone-mode sparse
// checkouts that cannot see the protocol package.
//
// Three copies can disagree, and a disagreement is silent in the worst
// direction: a port keeps asserting conformance against an older corpus and
// stays green while the protocol has moved underneath it. This check is what
// makes that loud. `bun run vectors:gen` writes all three from one generation.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Keep in step with CORPUS_PATHS in
// packages/simplysync-protocol/scripts/gen-vectors.ts.
const COPIES = [
  "packages/simplysync-protocol/test/vectors.json",
  "apps/todolist/swift/verify/vectors.json",
  "apps/todolist/kotlin/src/test/resources/vectors.json",
];

const digests = COPIES.map((path) => {
  const absolute = join(REPO_ROOT, path);
  let bytes;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    console.error(`Missing corpus copy: ${path}`);
    console.error(String(error));
    process.exit(1);
  }
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
});

const [reference] = digests;
const drifted = digests.filter((d) => d.sha256 !== reference.sha256);

if (drifted.length > 0) {
  console.error("Conformance corpus copies have drifted:\n");
  for (const { path, sha256 } of digests) {
    const mark = sha256 === reference.sha256 ? " " : "✗";
    console.error(`  ${mark} ${sha256.slice(0, 16)}  ${path}`);
  }
  console.error(
    "\nEvery port asserts against its own copy, so a stale one proves " +
      "conformance to a protocol that no longer exists.\nRegenerate all three: " +
      "bun run vectors:gen",
  );
  process.exit(1);
}

console.log(
  `Conformance corpus identical across ${COPIES.length} copies ` +
    `(${reference.sha256.slice(0, 16)}…)`,
);
for (const { path } of digests) {
  console.log(`  ${relative(REPO_ROOT, join(REPO_ROOT, path))}`);
}
