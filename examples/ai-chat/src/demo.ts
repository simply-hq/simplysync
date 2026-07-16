import { aiAvailable } from "./ai";
import { sendAndReply } from "./chat";
import { createChatEngine, transcript } from "./engine";

// A non-interactive run of two turns through the engine. Verifiable offline:
// without ANTHROPIC_API_KEY it streams the offline stub; with a key it streams
// real Claude. Either way it exercises the local-first streaming-write path.
async function main(): Promise<void> {
  const engine = createChatEngine({ dbPath: ":memory:" });
  await engine.ready;

  console.log(
    `AI backend: ${aiAvailable() ? "Claude (live)" : "offline stub — set ANTHROPIC_API_KEY for real replies"}\n`,
  );

  const prompts = [
    "What is the capital of France?",
    "Roughly how many people live there?",
  ];
  for (const prompt of prompts) {
    process.stdout.write(`you ▸ ${prompt}\nai  ▸ `);
    await sendAndReply(engine, prompt, {
      onToken: (t) => process.stdout.write(t),
    });
    process.stdout.write("\n\n");
  }

  console.log("— transcript (ordered) —");
  for (const m of await transcript(engine)) {
    console.log(`${m.role.padEnd(9)} ${m.body}`);
  }

  // Let the async (encrypted) outbox enqueues settle, then show the payoff of
  // streaming with { local: true }: each turn queues the user message, the
  // assistant-message creation, and ONE committed reply — the streamed tokens
  // add zero sync events (a 500-token reply is 1 event, not 500).
  await new Promise((r) => setTimeout(r, 50));
  console.log(
    `\nqueued sync events: ${engine.getPendingOutboxCount()} ` +
      `(3 per turn × 2 turns; streamed tokens added none)`,
  );
}

void main();
