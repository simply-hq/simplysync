#!/usr/bin/env node
// Read-only. Rewrite-aware diff between the upstream SimplySync native kits and
// the app-owned ports. Strips the known mechanical rewrites (Swift `public`,
// Kotlin package rename) so only *real* divergence shows — the lines a human
// must port deliberately. Writes nothing; pairs with check-native-app-port-drift.mjs.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const roots = {
  simplysync: repoRoot,
  iosApp: resolve(process.env.SIMPLYFINANCE_IOS_ROOT ?? join(repoRoot, "..", "ios-simplyfinance")),
  androidApp: resolve(process.env.SIMPLYFINANCE_ANDROID_ROOT ?? join(repoRoot, "..", "android-simplyfinance")),
};

// Only clean-lineage kit pairs: same filenames on both sides, differing only by
// the mechanical rewrite plus deliberate app divergence. Engine/app-core files
// are not 1:1 filename copies — the fingerprint check covers those.
const PAIRS = [
  {
    name: "Swift kit",
    lang: "swift",
    ext: ".swift",
    upstream: { root: "simplysync", path: "Sources/SimplySync/Kit" },
    app: { root: "iosApp", path: "Packages/SimplySyncKit/Sources/SimplySyncKit" },
    normalize: (text) => text.split("\n").map((l) => l.replace(/^(\s*)public /, "$1")).join("\n"),
  },
  {
    name: "Kotlin kit",
    lang: "kotlin",
    ext: ".kt",
    upstream: { root: "simplysync", path: "apps/todolist/kotlin/src/main/kotlin/com/simplysync/kotlin" },
    app: { root: "androidApp", path: "synckit/src/main/kotlin/app/simplyfinance/synckit" },
    normalize: (text) => text.replaceAll("com.simplysync.kotlin", "§PKG§").replaceAll("app.simplyfinance.synckit", "§PKG§"),
  },
];

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const dim = (s) => c("2", s);
const bold = (s) => c("1", s);

function listFiles(dir, ext) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((e) => e.endsWith(ext) && statSync(join(dir, e)).isFile())
    .sort();
}

// git owns the diffing: write both normalized texts to temp files and run
// `git diff --no-index`, which brings hunking and color for free.
function gitDiff(upText, appText, label) {
  const dir = mkdtempSync(join(tmpdir(), "simplysync-port-diff-"));
  try {
    const upPath = join(dir, `upstream-${label}`);
    const appPath = join(dir, `app-${label}`);
    writeFileSync(upPath, upText);
    writeFileSync(appPath, appText);
    const result = spawnSync(
      "git",
      ["diff", "--no-index", `--color=${useColor ? "always" : "never"}`, "--", upPath, appPath],
      { encoding: "utf8" },
    );
    if (result.status === 0) return null;
    // Drop git's header noise (diff --git/index/---/+++ over temp paths).
    return result.stdout
      .split("\n")
      .filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l))
      .join("\n")
      .trimEnd();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const langFilter = args.filter((a) => a === "swift" || a === "kotlin");
  const fileFilter = args.filter((a) => a !== "swift" && a !== "kotlin");

  console.log(bold("SimplySync port diff") + dim("  (rewrite-aware; read-only)"));
  console.log(dim("  ignoring: Swift `public`, Kotlin package rename"));
  console.log(dim(`  ${red("-")} = upstream-only, port DOWN into app   ${green("+")} = app-only, deliberate divergence (keep)`));

  let diverged = 0;

  for (const pair of PAIRS) {
    if (langFilter.length && !langFilter.includes(pair.lang)) continue;
    const upDir = join(roots[pair.upstream.root], pair.upstream.path);
    const appDir = join(roots[pair.app.root], pair.app.path);
    console.log(`\n${bold(pair.name)}`);
    console.log(dim(`  upstream: ${upDir}`));
    console.log(dim(`  app:      ${appDir}`));

    const upFiles = new Set(listFiles(upDir, pair.ext));
    const appFiles = new Set(listFiles(appDir, pair.ext));
    const shared = [...upFiles].filter((f) => appFiles.has(f)).sort();
    const appOnly = [...appFiles].filter((f) => !upFiles.has(f)).sort();
    const upOnly = [...upFiles].filter((f) => !appFiles.has(f)).sort();

    for (const f of shared) {
      if (fileFilter.length && !fileFilter.some((q) => f.toLowerCase().includes(q.toLowerCase()))) continue;
      const up = pair.normalize(readFileSync(join(upDir, f), "utf8"));
      const app = pair.normalize(readFileSync(join(appDir, f), "utf8"));
      const diff = gitDiff(up, app, f);
      if (diff === null) {
        console.log(`  ${green("✓")} ${f} ${dim("in sync")}`);
        continue;
      }
      diverged++;
      console.log(`  ${red("✗")} ${f}`);
      console.log(diff.replace(/^/gm, "      "));
    }

    if (appOnly.length) console.log(dim(`  • app-only (kept, no upstream file): ${appOnly.join(", ")}`));
    if (upOnly.length) console.log(dim(`  • upstream-only (lives elsewhere in app, e.g. core): ${upOnly.join(", ")}`));
  }

  console.log("");
  if (diverged === 0) {
    console.log(green("All shared kit files are in sync (modulo rewrite)."));
  } else {
    console.log(bold(`${diverged} file(s) diverge beyond the rewrite.`) + dim(" Port deliberately — do not blind-copy; some divergence is intentional."));
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
