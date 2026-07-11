import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The two app repos are sibling checkouts of `simplysync` (see AGENTS.md), the
// same convention the drift scripts use (scripts/check-native-app-port-drift.mjs).
// CI, which checks them out elsewhere, overrides via the env vars.
const here = dirname(fileURLToPath(import.meta.url));
const simplysyncRoot = resolve(here, "../../..");
const workspaceRoot = resolve(simplysyncRoot, "..");

export type Platform = "ios" | "android";

export function iosRoot(): string {
  return requireDir(
    process.env.SIMPLYFINANCE_IOS_ROOT ?? resolve(workspaceRoot, "ios-simplyfinance"),
    "iOS app repo",
    "SIMPLYFINANCE_IOS_ROOT",
  );
}

export function androidRoot(): string {
  return requireDir(
    process.env.SIMPLYFINANCE_ANDROID_ROOT ?? resolve(workspaceRoot, "android-simplyfinance"),
    "Android app repo",
    "SIMPLYFINANCE_ANDROID_ROOT",
  );
}

function requireDir(path: string, label: string, envVar: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `${label} not found at ${path}. Check out the app repos next to simplysync, ` +
        `or set ${envVar} to its location.`,
    );
  }
  return path;
}
