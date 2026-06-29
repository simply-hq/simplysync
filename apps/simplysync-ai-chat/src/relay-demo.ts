import type { SecureStorage } from "@simplysync/engine";
import { aiAvailable } from "./ai";
import { sendAndReply } from "./chat";
import { createChatEngine, transcript } from "./engine";

// Two "devices" sharing one recovery phrase converge through a relay. To keep
// the demo self-contained (no relay process / ports), the relay is an in-process
// fetch impl backing the real push/pull protocol with a shared event log — the
// relay only ever sees opaque encrypted envelopes, exactly like the real one.
function makeFakeRelay() {
  const log: Array<Record<string, unknown> & { ownerId: string; eventId: string }> = [];
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.pathname === "/health") return json({ ok: true });

    if (url.pathname.endsWith("/v1/events") && (init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        ownerId: string;
        events: Array<Record<string, unknown> & { eventId: string }>;
      };
      let accepted = 0;
      for (const e of body.events) {
        if (!log.some((x) => x.eventId === e.eventId)) {
          log.push({ ...e, ownerId: body.ownerId });
          accepted++;
        }
      }
      return json({ accepted, duplicate: body.events.length - accepted });
    }

    if (url.pathname.endsWith("/v1/events")) {
      // GET pull — return events after the cursor (a monotonic seq = log index).
      const ownerId = url.searchParams.get("ownerId");
      const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
      const events = log
        .map((e, i) => ({ e, seq: i + 1 }))
        .filter(({ e, seq }) => seq > after && e.ownerId === ownerId)
        .map(({ e }) => e);
      return json({ events, nextCursor: String(log.length) });
    }

    return json({ error: "not found" }, 404);
  }) as typeof fetch;
}

const memStore = (): SecureStorage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const relayFetch = makeFakeRelay();
  const RELAY = "http://relay.local";
  console.log(
    `AI backend: ${aiAvailable() ? "Claude (live)" : "offline stub"}\n`,
  );

  // Device A creates an owner; device B adopts the same recovery phrase.
  const deviceA = createChatEngine({
    dbPath: ":memory:",
    relayUrls: [RELAY],
    fetch: relayFetch,
    secureStorage: memStore(),
  });
  await deviceA.ready;
  const owner = await deviceA.appOwner;

  const deviceB = createChatEngine({
    dbPath: ":memory:",
    relayUrls: [RELAY],
    fetch: relayFetch,
    externalAppOwner: owner,
    secureStorage: memStore(),
  });
  await deviceB.ready;
  console.log(
    `device A owner == device B owner: ${owner?.id === (await deviceB.appOwner)?.id}\n`,
  );

  // Chat on A (user message + streamed assistant reply), then push.
  console.log("device A ▸ sends a message and gets a reply");
  await sendAndReply(deviceA, "Hello from device A — what's 2+2?");

  // Push from A and pull to B until B has the full turn. (The reply commit
  // enqueues asynchronously after encryption, so sync both sides in the loop.)
  const isFullTurn = (rows: Awaited<ReturnType<typeof transcript>>) =>
    rows.length >= 2 && rows.every((m) => m.body.length > 0);
  for (let i = 0; i < 40 && !isFullTurn(await transcript(deviceB)); i++) {
    await deviceA.sync();
    await sleep(20);
    await deviceB.sync();
    await sleep(20);
  }

  console.log("\ndevice B transcript (synced from A):");
  for (const m of await transcript(deviceB)) {
    console.log(`  ${m.role.padEnd(9)} ${m.body}`);
  }

  const converged = (await transcript(deviceB)).some((m) =>
    m.body.includes("Hello from device A"),
  );
  console.log(`\nconverged: ${converged}`);
  // Relays are configured, so the engine's poll interval keeps the event loop
  // alive — exit explicitly (also flushes buffered stdout).
  process.exit(converged ? 0 : 1);
}

void main();
