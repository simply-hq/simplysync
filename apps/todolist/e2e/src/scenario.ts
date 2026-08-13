type PlatformRef = "swift" | "kotlin" | "web" | "$P1" | "$P2";

export interface Scenario {
  name: string;
  /** Recovery phrase shared by the devices (one user, many devices). */
  mnemonic?: string;
  devices: Record<string, { platform: PlatformRef; mnemonic?: string }>;
  /**
   * Go relays launched fresh for the scenario. `rejectStatus` swaps one out for a
   * stub that answers every request with that status, so a scenario can exercise
   * a client's failure handling without a second relay build.
   */
  relays?: { id: string; env?: Record<string, string>; rejectStatus?: number }[];
  steps: Step[];
}

/** A `do` action routed to a device's runner, or an `assert` checked by the harness. */
export type Step = DoStep | AssertStep;

export interface DoStep {
  do: string;
  device?: string;
  /** Store this action's result object under a name for later `$name.field` refs. */
  capture?: string;
  [key: string]: unknown;
}

export interface AssertStep {
  assert: string;
  [key: string]: unknown;
}

export function isAssert(step: Step): step is AssertStep {
  return "assert" in step;
}

export const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Resolve `$var` / `$var.field` references (and nested structures) against captured vars. */
export function resolve(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const path = value.slice(1).split(".");
    let cur: unknown = vars[path[0]];
    for (const key of path.slice(1)) {
      if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[key];
      else return undefined;
    }
    return cur;
  }
  // { "$repeat": { "of": "x", "times": 100000 } } → a big string, so a scenario
  // can exercise large payloads without a giant literal in the JSON.
  if (value && typeof value === "object" && "$repeat" in value) {
    const spec = (value as { $repeat: { of: string; times: number } }).$repeat;
    return String(spec.of).repeat(Number(spec.times));
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolve(v, vars)]),
    );
  }
  return value;
}
