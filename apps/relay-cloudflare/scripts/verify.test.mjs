import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { deployedRelayUrl, verifyRelayHealth } from "./verify.mjs";

test("reads the public Worker URL from Wrangler structured output", () => {
  const output = [
    JSON.stringify({ type: "other", targets: [] }),
    JSON.stringify({
      type: "deploy",
      targets: ["schedule: 0 */6 * * *", "https://relay.owner.workers.dev"],
    }),
  ].join("\n");

  assert.equal(deployedRelayUrl(output), "https://relay.owner.workers.dev");
});

test("retries until the relay reports ok", async (context) => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(request.url, "/health");
    response.setHeader("content-type", "application/json");
    if (requests === 1) {
      response.writeHead(503).end(JSON.stringify({ ok: false }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  context.after(() => server.close());

  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert(address && typeof address === "object");

  const healthUrl = await verifyRelayHealth(
    `http://127.0.0.1:${address.port}`,
    { intervalMs: 5, timeoutMs: 1_000 },
  );

  assert.equal(healthUrl, `http://127.0.0.1:${address.port}/health`);
  assert.equal(requests, 2);
});

test("rejects a response that is healthy-looking but not ok", async (context) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: false }));
  });
  context.after(() => server.close());

  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert(address && typeof address === "object");

  await assert.rejects(
    verifyRelayHealth(`http://127.0.0.1:${address.port}`, {
      intervalMs: 5,
      timeoutMs: 30,
    }),
    /Relay health check failed/u,
  );
});
