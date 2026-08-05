import { resolve } from "node:path";
import { cliRoot } from "./support";

/** Local SQLite files + per-device secret files for the todo example. */
export const todoDataDir = resolve(cliRoot, "data");

/**
 * The owner shared by every device in the example, written by `todo:dev`. Real
 * apps never write a recovery key to disk in the clear — this exists so two
 * terminals (and the Swift/Kotlin harnesses) can join one account without
 * copy-pasting a key.
 */
export const OWNER_FILE = resolve(todoDataDir, "owner.json");
