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
      if (!target || await targetExists(target)) continue;
      const line = markdown.slice(0, match.index).split("\n").length;
      failures.push({
        source: source.slice(repoRoot.length + 1),
        line,
        href,
      });
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `${failure.source}:${failure.line}: missing local link ${failure.href}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Verified local links in ${files.length} Markdown files.`);
}

await main();
