import { readdir, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  "Pods",
  "build",
  "dist",
  "node_modules",
]);

// The docs builder creates this page from the TodoList web application rather
// than from a same-named source file.
const generatedTargets = new Set([
  resolve(repoRoot, "docs/local-first/demo.html"),
]);

interface Failure {
  readonly source: string;
  readonly line: number;
  readonly href: string;
  readonly reason?: string;
}

// A link into one of these is a pointer at code, so the symbols named alongside
// it on the same line should actually live there. A trust page (SECURITY.md)
// whose "verify in this file" pointers have gone stale is worse than none, and
// the plain path-exists check above never catches a file that still exists but
// no longer defines the symbol.
const sourceExtensions = new Set([
  ".go",
  ".js",
  ".kt",
  ".mjs",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
]);

// A bare code identifier: `encryptPayload`, `ensureOwnerAuth`. Excludes paths
// (`a/b.ts`), package names (`@simplysync/engine`), and hyphenated non-symbols
// (`AES-GCM`) so the check only fires on things that are plausibly definitions.
const bareIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function sameLineSymbols(markdown: string, matchIndex: number): string[] {
  const lineStart = markdown.lastIndexOf("\n", matchIndex) + 1;
  const lineEndRaw = markdown.indexOf("\n", matchIndex);
  const lineEnd = lineEndRaw === -1 ? markdown.length : lineEndRaw;
  const line = markdown.slice(lineStart, lineEnd);
  const symbols: string[] = [];
  for (const token of line.matchAll(/`([^`]+)`/g)) {
    const value = token[1];
    if (bareIdentifier.test(value)) symbols.push(value);
  }
  return symbols;
}

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (
        !entry.name.startsWith(".")
        && !ignoredDirectories.has(entry.name)
      ) {
        files.push(...await collectMarkdownFiles(resolve(directory, entry.name)));
      }
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      files.push(resolve(directory, entry.name));
    }
  }
  return files;
}

function localTarget(href: string, source: string): string | null {
  const cleaned = href.replace(/^<|>$/g, "");
  if (
    cleaned === ""
    || cleaned.startsWith("#")
    || cleaned.startsWith("/")
    || /^[a-z][a-z0-9+.-]*:/i.test(cleaned)
  ) {
    return null;
  }

  const path = cleaned.split(/[?#]/, 1)[0];
  if (!path) return null;

  try {
    return resolve(dirname(source), decodeURIComponent(path));
  } catch {
    return resolve(dirname(source), path);
  }
}

async function targetExists(target: string): Promise<boolean> {
  if (generatedTargets.has(target)) return true;
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const failures: Failure[] = [];
  const files = await collectMarkdownFiles(repoRoot);

  for (const source of files) {
    const markdown = await Bun.file(source).text();
    const linkPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    for (const match of markdown.matchAll(linkPattern)) {
      const href = match[1];
      const target = localTarget(href, source);
      if (!target) continue;
      const rel = source.slice(repoRoot.length + 1);
      const lineOf = () => markdown.slice(0, match.index).split("\n").length;
      if (!await targetExists(target)) {
        failures.push({ source: rel, line: lineOf(), href });
        continue;
      }
      // The link resolves. On the trust page, also verify that at least one
      // code symbol named in backticks on the same line actually lives in that
      // file — this catches a pointer that still resolves but no longer names
      // the thing it claims to. Scoped to SECURITY.md on purpose: that page
      // stakes its credibility on "verify this exact file", whereas design docs
      // (matrix.md) legitimately backtick DB columns and HTTP verbs next to
      // links, which this substring check can't tell apart from symbols.
      if (
        rel !== "SECURITY.md"
        || generatedTargets.has(target)
        || !sourceExtensions.has(extname(target).toLowerCase())
      ) {
        continue;
      }
      const symbols = sameLineSymbols(markdown, match.index ?? 0);
      if (symbols.length === 0) continue;
      const contents = await Bun.file(target).text();
      if (!symbols.some((symbol) => contents.includes(symbol))) {
        failures.push({
          source: rel,
          line: lineOf(),
          href,
          reason: `no same-line symbol [${symbols.join(", ")}] found in target`,
        });
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      const detail = failure.reason
        ? `stale code pointer ${failure.href} (${failure.reason})`
        : `missing local link ${failure.href}`;
      console.error(`${failure.source}:${failure.line}: ${detail}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Verified local links in ${files.length} Markdown files.`);
}

await main();
