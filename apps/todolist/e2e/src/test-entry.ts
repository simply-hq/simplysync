// `turbo run test` entry point. The native matrix builds Kotlin and Swift, so it
// stays opt-in during the normal workspace test pass. Dedicated CI jobs invoke
// `bun run todo:e2e -- --matrix …` directly.
import { run } from "./cli.ts";

if (!process.env.SIMPLYSYNC_TODO_E2E) {
  console.log("todo-e2e: skipped (set SIMPLYSYNC_TODO_E2E=1 to run; needs Go and native toolchains)");
  process.exit(0);
}

const code = await run(["--matrix", "web-kotlin,kotlin-kotlin"]);
process.exit(code);
