import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

export type Platform = "swift" | "kotlin" | "web";

export function swiftRoot(): string {
  return requireDir(resolve(repoRoot, "apps/todolist/swift"), "TodoList Swift client");
}

export function kotlinRoot(): string {
  return requireDir(resolve(repoRoot, "apps/todolist/kotlin"), "TodoList Kotlin client");
}

function requireDir(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new Error(`${label} not found at ${path}`);
  }
  return path;
}
