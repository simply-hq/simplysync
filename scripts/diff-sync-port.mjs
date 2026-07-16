#!/usr/bin/env node
// Read-only. Rewrite-aware diff between the upstream SimplySync native kits and
// the app-owned ports. Strips the known mechanical rewrites (Swift `public`,
// Kotlin package rename) so only *real* divergence shows — the lines a human
// must port deliberately. Writes nothing; pairs with check-native-app-port-drift.mjs.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
    upstream: { root: "simplysync", path: "ports/swift/SimplySyncDemo/Kit" },
    app: { root: "iosApp", path: "Packages/SimplySyncKit/Sources/SimplySyncKit" },
    normalize: (text) => text.split("\n").map((l) => l.replace(/^(\s*)public /, "$1")).join("\n"),
  },
  {
    name: "Kotlin kit",
    lang: "kotlin",
    ext: ".kt",
    upstream: { root: "simplysync", path: "ports/kotlin/src/main/kotlin/com/simplysync/kotlin" },
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

// LCS line diff. a = upstream, b = app.
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ t: " ", line: a[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "-", line: a[i++] });
    else out.push({ t: "+", line: b[j++] });
  }
  while (i < n) out.push({ t: "-", line: a[i++] });
  while (j < m) out.push({ t: "+", line: b[j++] });
  return out;
}

// Collapse to hunks with up to CONTEXT unchanged lines around each change.
function hunks(diff, context = 3) {
  const keep = new Array(diff.length).fill(false);
  for (let k = 0; k < diff.length; k++) {
    if (diff[k].t !== " ") {
      for (let d = -context; d <= context; d++) {
        if (k + d >= 0 && k + d < diff.length) keep[k + d] = true;
      }
    }
  }
  const groups = [];
  let cur = null;
  for (let k = 0; k < diff.length; k++) {
    if (keep[k]) {
      if (!cur) cur = [];
      cur.push(diff[k]);
    } else if (cur) {
      groups.push(cur);
      cur = null;
    }
  }
  if (cur) groups.push(cur);
  return groups;
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
      const up = pair.normalize(readFileSync(join(upDir, f), "utf8")).split("\n");
      const app = pair.normalize(readFileSync(join(appDir, f), "utf8")).split("\n");
      const diff = diffLines(up, app);
      const added = diff.filter((d) => d.t === "+").length;
      const removed = diff.filter((d) => d.t === "-").length;
      if (added === 0 && removed === 0) {
        console.log(`  ${green("✓")} ${f} ${dim("in sync")}`);
        continue;
      }
      diverged++;
      console.log(`  ${red("✗")} ${f}  ${red(`-${removed}`)} ${green(`+${added}`)}`);
      for (const g of hunks(diff)) {
        console.log(dim("      @@"));
        for (const d of g) {
          if (d.t === "+") console.log("      " + green(`+ ${d.line}`));
          else if (d.t === "-") console.log("      " + red(`- ${d.line}`));
          else console.log("      " + dim(`  ${d.line}`));
        }
      }
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
