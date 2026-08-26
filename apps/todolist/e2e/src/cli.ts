import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Harness, type Pairing } from "./harness.ts";
import { cleanupGoBinary, isGoAvailable } from "./relay.ts";
import type { Platform } from "./roots.ts";
import type { Scenario } from "./scenario.ts";

const scenariosDir = resolve(dirname(fileURLToPath(import.meta.url)), "../scenarios");

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      matrix: { type: "string", default: "swift-kotlin,kotlin-kotlin,swift-swift,web-swift,web-kotlin" },
      scenario: { type: "string" },
    },
  });
  const opts = {
    matrix: values.matrix.split(",").map(parsePairing),
    scenarioFilter: values.scenario,
  };

  if (!isGoAvailable()) {
    console.error("✗ `go` is not on PATH — the Go relay can't be launched. Install Go and retry.");
    return 1;
  }

  const scenarios = loadScenarios(opts.scenarioFilter);
  if (scenarios.length === 0) {
    console.error(`✗ no scenarios matched${opts.scenarioFilter ? ` '${opts.scenarioFilter}'` : ""}`);
    return 1;
  }

  const platforms = new Set<Platform>(opts.matrix.flat());
  const workDir = mkdtempSync(join(tmpdir(), "simplysync-todolist-e2e-"));
  const harness = new Harness(workDir);

  console.log(`todo-e2e: ${scenarios.length} scenario(s) × ${opts.matrix.length} pairing(s)`);
  console.log(`starting TodoList runners: ${[...platforms].join(", ")}…`);

  let failures = 0;
  try {
    await harness.prestart([...platforms]);
    for (const pairing of opts.matrix) {
      for (const scenario of scenarios) {
        const label = `[${pairing.join("↔")}] ${scenario.name}`;
        const started = Date.now();
        try {
          await harness.runScenario(scenario, pairing);
          console.log(`✓ ${label} (${Date.now() - started}ms)`);
        } catch (err) {
          failures++;
          console.error(`✗ ${label}\n    ${(err as Error).message.replace(/\n/g, "\n    ")}`);
        }
      }
    }
  } catch (err) {
    console.error(`✗ fatal: ${(err as Error).message}`);
    failures++;
  } finally {
    await harness.shutdown();
    cleanupGoBinary();
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nall scenarios passed" : `\n${failures} scenario(s) failed`);
  return failures === 0 ? 0 : 1;
}

function parsePairing(token: string): Pairing {
  const parts = token.split("-");
  if (parts.length !== 2 || !parts.every(isPlatform)) {
    throw new Error(`bad pairing '${token}' (expected e.g. swift-kotlin)`);
  }
  return [parts[0] as Platform, parts[1] as Platform];
}

function isPlatform(s: string): s is Platform {
  return s === "swift" || s === "kotlin" || s === "web";
}

function loadScenarios(filter?: string): Scenario[] {
  return readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(scenariosDir, f), "utf8")) as Scenario)
    .filter((s) => !filter || s.name.includes(filter))
    .sort((a, b) => a.name.localeCompare(b.name));
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
