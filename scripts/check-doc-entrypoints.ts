import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const start = "<!-- quickstart:react-native:start -->";
const end = "<!-- quickstart:react-native:end -->";

async function quickstart(path: string): Promise<string> {
  const markdown = await readFile(resolve(repoRoot, path), "utf8");
  const startAt = markdown.indexOf(start);
  const endAt = markdown.indexOf(end);
  if (startAt < 0 || endAt < 0 || endAt <= startAt) {
    throw new Error(`${path} is missing the shared React Native quickstart markers`);
  }
  return markdown.slice(startAt + start.length, endAt).trim();
}

const readme = await quickstart("README.md");
const docsLanding = await quickstart("docs/local-first/README.md");

if (readme !== docsLanding) {
  throw new Error(
    "README.md and the docs-site landing page have different React Native quickstarts",
  );
}

for (const required of [
  "sh -s -- react-native simplysync-mobile",
  "scaffold-simplysync.sh react-native",
  "bun install --no-save",
  "bun run build",
  "bun run --cwd apps/my-notes ios",
  "bun run --cwd apps/my-notes android",
  "I saved this key",
  "Relay URL",
  "Cloudflare",
]) {
  if (!readme.includes(required)) {
    throw new Error(`shared quickstart is missing required step: ${required}`);
  }
}

for (const removed of [
  "--with-relay",
  "bun run relay:go",
  "Go 1.25",
  "127.0.0.1:4100",
  "10.0.2.2:4100",
]) {
  if (readme.includes(removed)) {
    throw new Error(`shared quickstart still includes removed setup: ${removed}`);
  }
}

console.log("README and docs-site quickstarts match.");
