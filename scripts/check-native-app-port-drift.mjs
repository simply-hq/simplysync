#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const manifestPath = join(scriptDir, "native-app-port-manifest.json");
const args = new Set(process.argv.slice(2));
const update = args.has("--update");

const roots = {
  simplysync: repoRoot,
  iosApp: resolve(process.env.SIMPLYFINANCE_IOS_ROOT ?? join(repoRoot, "..", "ios-simplyfinance")),
  androidApp: resolve(process.env.SIMPLYFINANCE_ANDROID_ROOT ?? join(repoRoot, "..", "android-simplyfinance")),
};

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function listFiles(base, tree) {
  const root = join(base, tree.path);
  if (!existsSync(root)) {
    throw new Error(`${tree.name}: missing path ${root}`);
  }

  if (tree.files) {
    return tree.files.map((file) => {
      const full = join(root, file);
      if (!existsSync(full)) throw new Error(`${tree.name}: missing file ${full}`);
      return full;
    });
  }

  const suffixes = new Set(tree.extensions ?? []);
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!entry.startsWith(".") && entry !== "build") walk(full);
      } else if (suffixes.size === 0 || [...suffixes].some((suffix) => entry.endsWith(suffix))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function digestTree(tree) {
  const base = roots[tree.root];
  if (!base) throw new Error(`${tree.name}: unknown root ${tree.root}`);
  const root = join(base, tree.path);
  const files = listFiles(base, tree).sort();
  const h = createHash("sha256");
  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    h.update(rel);
    h.update("\0");
    h.update(sha256(readFileSync(file)));
    h.update("\0");
  }
  return { hash: h.digest("hex"), fileCount: files.length };
}

function main() {
  const manifest = readManifest();
  const changed = [];

  for (const tree of manifest.trees) {
    const current = digestTree(tree);
    if (update) {
      tree.sha256 = current.hash;
      tree.fileCount = current.fileCount;
      continue;
    }
    if (tree.sha256 !== current.hash || tree.fileCount !== current.fileCount) {
      changed.push({ tree, current });
    }
  }

  if (update) {
    manifest.updatedAt = new Date().toISOString();
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Updated ${relative(process.cwd(), manifestPath)}`);
    return;
  }

  if (changed.length === 0) {
    console.log("Native app sync-port drift check passed.");
    return;
  }

  console.error("Native app sync-port drift check failed.\n");
  for (const { tree, current } of changed) {
    console.error(`- ${tree.name}`);
    console.error(`  ${tree.note}`);
    console.error(`  expected ${tree.sha256} (${tree.fileCount} files)`);
    console.error(`  actual   ${current.hash} (${current.fileCount} files)`);
  }
  console.error("\nReview/port the sync change into both apps, then refresh the baseline with:");
  console.error("  bun run app-port:update");
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
