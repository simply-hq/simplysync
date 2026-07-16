// `turbo run test` entry point. This suite needs Go on PATH and the sibling app
// repos checked out, so it stays OPT-IN: without SF_APP_E2E=1 it no-ops (keeps
// the default `bun run test` green in the plain CI job). The dedicated CI job
// invokes `bun run app-e2e -- --matrix …` directly instead of going through here.
import { run } from "./cli.ts";

if (!process.env.SF_APP_E2E) {
  console.log("app-e2e: skipped (set SF_APP_E2E=1 to run; needs Go + the app repos)");
  process.exit(0);
}

const code = await run(["--matrix", "android-android"]);
process.exit(code);
