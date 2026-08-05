#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export function deployedRelayUrl(wranglerOutput) {
  const entries = wranglerOutput
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  for (const entry of entries.reverse()) {
    if (entry.type !== "deploy" || !Array.isArray(entry.targets)) continue;
    const target = entry.targets.find(
      (candidate) =>
        typeof candidate === "string" &&
        /^https:\/\/[^/]+\.workers\.dev\/?$/u.test(candidate),
    );
    if (target) return target.replace(/\/+$/u, "");
  }

  throw new Error(
    "Wrangler deployed the Worker but did not report a workers.dev URL. " +
      "Confirm workers_dev is enabled, then rerun setup.",
  );
}

export async function verifyRelayHealth(
  relayUrl,
  { fetchImpl = fetch, intervalMs = 1_000, timeoutMs = 30_000 } = {},
) {
  const healthUrl = new URL(relayUrl);
  if (!/^https?:$/u.test(healthUrl.protocol)) {
    throw new Error("Relay URL must use http or https.");
  }
  healthUrl.pathname = `${healthUrl.pathname.replace(/\/+$/u, "")}/health`;
  healthUrl.search = "";
  healthUrl.hash = "";

  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no response";

  do {
    const remaining = Math.max(1, deadline - Date.now());
    const controller = new AbortController();
    const abortTimer = setTimeout(
      () => controller.abort(),
      Math.min(5_000, remaining),
    );

    try {
      const response = await fetchImpl(healthUrl, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      const body = await response.text();
      if (response.ok) {
        try {
          if (JSON.parse(body).ok === true) return healthUrl.toString();
        } catch {
          // The failure below includes the response body for diagnosis.
        }
      }
      lastFailure = `${response.status} ${body.slice(0, 160)}`.trim();
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(abortTimer);
    }

    const wait = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleep(wait);
  } while (Date.now() < deadline);

  throw new Error(
    `Relay health check failed at ${healthUrl.toString()}: ${lastFailure}`,
  );
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const relayUrl = process.argv[2];
  if (!relayUrl) {
    console.error("Usage: node scripts/verify.mjs <relay-url>");
    process.exit(2);
  }

  try {
    const healthUrl = await verifyRelayHealth(relayUrl);
    console.log(`Relay verified: ${healthUrl}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
