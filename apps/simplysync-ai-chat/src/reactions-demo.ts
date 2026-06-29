import { aiAvailable } from "./ai";
import { sendAndReply } from "./chat";
import { createChatEngine, transcript } from "./engine";
import { react, reactionSummary } from "./reactions";

const EMOJIS = ["👍", "❤️", "🎉", "🤔"] as const;

// Shows conflict-free reactions on the assistant's reply. Rapid taps (the exact
// pattern a single-integer LWW column would collapse to 1) all land.
async function main(): Promise<void> {
  const engine = createChatEngine({ dbPath: ":memory:" });
  await engine.ready;
  console.log(
    `AI backend: ${aiAvailable() ? "Claude (live)" : "offline stub"}\n`,
  );

  console.log("you ▸ Give me a one-line productivity tip.");
  const reply = await sendAndReply(engine, "Give me a one-line productivity tip.");
  console.log(`ai  ▸ ${reply}\n`);

  const assistantMsg = (await transcript(engine)).find((m) => m.role === "assistant")!;

  // 5 quick 👍 (e.g. rapid taps / two devices at once), 2 ❤️, 1 🎉.
  for (let i = 0; i < 5; i++) react(engine, assistantMsg.id, "👍");
  react(engine, assistantMsg.id, "❤️");
  react(engine, assistantMsg.id, "❤️");
  react(engine, assistantMsg.id, "🎉");

  const summary = await reactionSummary(engine, assistantMsg.id, EMOJIS);
  console.log("reactions on the reply:");
  for (const { emoji, count } of summary) console.log(`  ${emoji} ${count}`);
  console.log("\n(5 rapid 👍 all counted — no lost increments under LWW.)");
}

void main();
