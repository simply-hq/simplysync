import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchRelay, type LaunchedRelay } from "./relay.ts";
import { KotlinRunner } from "./runners/kotlin.ts";
import type { Runner } from "./runners/runner.ts";
import { SwiftRunner } from "./runners/swift.ts";
import type { Platform } from "./roots.ts";
import {
  diffStates,
  findRow,
  formatDiffs,
  type DeviceState,
} from "./state.ts";
import {
  isAssert,
  resolve,
  TEST_MNEMONIC,
  type AssertStep,
  type DoStep,
  type Scenario,
  type Step,
} from "./scenario.ts";

export type Pairing = [Platform, Platform];

export class AssertionError extends Error {}

/** Owns the (lazily started, reused) runners and executes scenarios against them. */
export class Harness {
  private runners = new Map<Platform, Runner>();

  constructor(private workDir: string) {
    mkdirSync(workDir, { recursive: true });
  }

  private async runnerFor(platform: Platform): Promise<Runner> {
    let runner = this.runners.get(platform);
    if (!runner) {
      const mailboxDir = join(this.workDir, `mailbox-${platform}`);
      const log = join(this.workDir, `${platform}-runner.log`);
      runner = platform === "ios" ? new SwiftRunner(mailboxDir, log) : new KotlinRunner(mailboxDir, log);
      await runner.start();
      this.runners.set(platform, runner);
    }
    return runner;
  }

  /** Build and spawn the runners for the given platforms up front (fail fast). */
  async prestart(platforms: Platform[]): Promise<void> {
    for (const platform of platforms) await this.runnerFor(platform);
  }

  async shutdown(): Promise<void> {
    for (const runner of this.runners.values()) await runner.stop();
    this.runners.clear();
  }

  /** Run one scenario under one platform pairing. Throws AssertionError on failure. */
  async runScenario(scenario: Scenario, pairing: Pairing): Promise<void> {
    const ctx = await this.setup(scenario, pairing);
    try {
      for (const [i, step] of scenario.steps.entries()) {
        try {
          if (isAssert(step)) await this.runAssert(step, ctx);
          else await this.runDo(step, ctx);
        } catch (err) {
          const label = isAssert(step) ? `assert ${step.assert}` : `do ${step.do}`;
          throw new AssertionError(`step ${i + 1} (${label}): ${(err as Error).message}`);
        }
      }
    } finally {
      for (const relay of ctx.relays.values()) await relay.kill();
    }
  }

  // MARK: setup

  private async setup(scenario: Scenario, pairing: Pairing): Promise<Ctx> {
    const devices = new Map<string, DeviceBinding>();
    for (const [key, def] of Object.entries(scenario.devices)) {
      const platform = bindPlatform(def.platform, pairing);
      const internalId = `${pairing.join("-")}__${scenario.name}__${key}`;
      const runner = await this.runnerFor(platform);
      devices.set(key, { platform, internalId, runner });
      await runner.mailbox.request({
        cmd: "init",
        device: internalId,
        mnemonic: def.mnemonic ?? scenario.mnemonic ?? TEST_MNEMONIC,
        deviceId: internalId,
        dbPath: join(this.workDir, `${sanitize(internalId)}.db`),
      });
    }

    const relays = new Map<string, LaunchedRelay>();
    for (const spec of scenario.relays ?? []) {
      relays.set(spec.id, await launchRelay("go", spec.env ?? {}));
    }

    return { devices, relays, vars: {} };
  }

  // MARK: do steps

  private async runDo(step: DoStep, ctx: Ctx): Promise<void> {
    const result = await this.execDo(step, ctx);
    if (step.capture) ctx.vars[step.capture] = result;
  }

  private async execDo(step: DoStep, ctx: Ctx): Promise<unknown> {
    const dev = () => this.device(step.device, ctx);
    const r = (v: unknown) => resolve(v, ctx.vars);

    switch (step.do) {
      case "mutate":
        return this.send(dev(), {
          cmd: "mutate",
          table: step.table,
          rowId: r(step.rowId),
          values: r(step.values) ?? {},
          op: step.op,
        });
      case "mutateMany":
        return this.send(dev(), { cmd: "mutateMany", ops: r(step.ops) });
      case "mutateRange": {
        // Generate `count` rows (rowId = prefix+i) sharing `values`. Keeps
        // large scenarios (pagination, batching) out of the JSON literal.
        const count = Number(step.count);
        const values = r(step.values) ?? {};
        const ops = Array.from({ length: count }, (_, i) => ({
          table: step.table,
          rowId: `${step.rowIdPrefix}${i}`,
          values,
          op: step.op,
        }));
        return this.send(dev(), { cmd: "mutateMany", ops });
      }
      case "sync":
        return this.send(dev(), { cmd: "sync", relayUrl: this.relayUrl(step.relay, ctx) });
      case "syncExpectError":
        return this.send(dev(), {
          cmd: "syncExpectError",
          relayUrl: (step.relay ? this.relayUrl(step.relay, ctx) : step.relayUrl) as string,
        });
      case "rawPush":
        return this.send(dev(), {
          cmd: "rawPush",
          relayUrl: this.relayUrl(step.relay, ctx),
          authOverride: step.authOverride ?? "wrong-bearer-token",
        });
      case "pruneOutbox":
        return this.send(dev(), { cmd: "pruneOutbox", relayUrls: this.relayUrls(step.relays, ctx) });
      case "purgeRows":
        return this.send(dev(), {
          cmd: "purgeRows",
          rows: r(step.rows),
          requirePushed: step.requirePushed ?? true,
        });
      case "purgeDeleted":
        return this.send(dev(), {
          cmd: "purgeDeleted",
          olderThanMs: step.olderThanMs ?? 0,
          requirePushed: step.requirePushed ?? true,
        });
      case "drainPurgeQueue":
        return this.send(dev(), { cmd: "drainPurgeQueue", relayUrls: this.relayUrls(step.relays, ctx) });
      case "pinMakeHash":
        return this.send(dev(), { cmd: "pinMakeHash", pin: step.pin });
      case "pinVerify":
        return this.send(dev(), { cmd: "pinVerify", pin: step.pin, stored: r(step.stored) });
      case "idFromString":
        return this.send(dev(), { cmd: "idFromString", value: step.value });
      case "readRow": {
        const state = await this.exportState(dev());
        const row = findRow(state, step.table as string, String(r(step.rowId)));
        if (!row) throw new Error(`readRow: ${step.table}#${r(step.rowId)} not found`);
        return row;
      }
      default:
        throw new Error(`unknown do verb '${step.do}'`);
    }
  }

  // MARK: assert steps

  private async runAssert(step: AssertStep, ctx: Ctx): Promise<void> {
    const r = (v: unknown) => resolve(v, ctx.vars);
    switch (step.assert) {
      case "statesEqual": {
        const keys = step.devices as string[];
        const base = this.device(keys[0], ctx);
        const baseState = await this.exportState(base);
        for (const other of keys.slice(1)) {
          const dev = this.device(other, ctx);
          const state = await this.exportState(dev);
          const crossPlatform = dev.platform !== base.platform;
          const diffs = diffStates(keys[0], baseState, other, state, { crossPlatform });
          if (diffs.length) {
            throw new AssertionError(
              `states diverge (${keys[0]} vs ${other}${crossPlatform ? ", cross-platform" : ""}):\n` +
                formatDiffs(diffs),
            );
          }
        }
        return;
      }
      case "row": {
        const dev = this.device(step.device as string, ctx);
        const state = await this.exportState(dev);
        const row = findRow(state, step.table as string, String(r(step.rowId)));
        if (!row) throw new AssertionError(`row ${step.table}#${r(step.rowId)} not found on ${step.device}`);
        for (const [col, expected] of Object.entries((r(step.expect) ?? {}) as Record<string, unknown>)) {
          if (row[col] !== expected) {
            throw new AssertionError(`row ${step.table}#${r(step.rowId)}.${col}: got ${fmt(row[col])}, want ${fmt(expected)}`);
          }
        }
        return;
      }
      case "noRow": {
        const dev = this.device(step.device as string, ctx);
        const state = await this.exportState(dev);
        const row = findRow(state, step.table as string, String(r(step.rowId)));
        if (row) throw new AssertionError(`row ${step.table}#${r(step.rowId)} unexpectedly present on ${step.device}`);
        return;
      }
      case "outboxCount": {
        const res = await this.send(this.device(step.device as string, ctx), { cmd: "outboxCount" });
        if (res.count !== step.expect) {
          throw new AssertionError(`outboxCount on ${step.device}: got ${res.count}, want ${step.expect}`);
        }
        return;
      }
      case "meta": {
        const res = await this.send(this.device(step.device as string, ctx), { cmd: "readMeta", key: step.key });
        if (step.exists !== undefined && (res.value != null) !== step.exists) {
          throw new AssertionError(`meta '${step.key}' on ${step.device}: exists=${res.value != null}, want ${step.exists}`);
        }
        if (step.equals !== undefined && res.value !== r(step.equals)) {
          throw new AssertionError(`meta '${step.key}' on ${step.device}: got ${fmt(res.value)}, want ${fmt(r(step.equals))}`);
        }
        return;
      }
      case "equals": {
        const actual = r(step.actual);
        const expected = r(step.expected);
        if (actual !== expected) throw new AssertionError(`equals: got ${fmt(actual)}, want ${fmt(expected)}`);
        return;
      }
      case "atLeast": {
        const actual = Number(r(step.actual));
        const expected = Number(r(step.expected));
        if (!(actual >= expected)) throw new AssertionError(`atLeast: ${actual} < ${expected}`);
        return;
      }
      case "matches": {
        const actual = String(r(step.actual));
        if (!new RegExp(step.pattern as string).test(actual)) {
          throw new AssertionError(`matches: ${fmt(actual)} !~ /${step.pattern}/`);
        }
        return;
      }
      default:
        throw new Error(`unknown assert '${step.assert}'`);
    }
  }

  // MARK: helpers

  private device(key: string | undefined, ctx: Ctx): DeviceBinding {
    if (!key) throw new Error("step is missing 'device'");
    const dev = ctx.devices.get(key);
    if (!dev) throw new Error(`unknown device '${key}'`);
    return dev;
  }

  private send(dev: DeviceBinding, payload: Record<string, unknown>): Promise<any> {
    return dev.runner.mailbox.request({ ...payload, device: dev.internalId });
  }

  private async exportState(dev: DeviceBinding): Promise<DeviceState> {
    return this.send(dev, { cmd: "exportState" });
  }

  private relayUrl(id: unknown, ctx: Ctx): string {
    const relay = ctx.relays.get(String(id));
    if (!relay) throw new Error(`unknown relay '${id}'`);
    return relay.baseUrl;
  }

  private relayUrls(ids: unknown, ctx: Ctx): string[] {
    return ((ids as string[]) ?? []).map((id) => this.relayUrl(id, ctx));
  }
}

interface DeviceBinding {
  platform: Platform;
  internalId: string;
  runner: Runner;
}

interface Ctx {
  devices: Map<string, DeviceBinding>;
  relays: Map<string, LaunchedRelay>;
  vars: Record<string, unknown>;
}

function bindPlatform(ref: string, pairing: Pairing): Platform {
  if (ref === "$P1") return pairing[0];
  if (ref === "$P2") return pairing[1];
  if (ref === "ios" || ref === "android") return ref;
  throw new Error(`bad platform ref '${ref}'`);
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function fmt(v: unknown): string {
  return v === null || v === undefined ? "null" : JSON.stringify(v);
}
