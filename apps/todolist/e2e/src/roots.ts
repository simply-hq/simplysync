import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export type Platform = "swift" | "kotlin" | "web";

export const swiftRoot = resolve(repoRoot, "apps/todolist/swift");
export const kotlinRoot = resolve(repoRoot, "apps/todolist/kotlin");
