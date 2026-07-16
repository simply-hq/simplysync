import { createInterface } from "node:readline/promises";
import { aiAvailable } from "./ai";
import { sendAndReply } from "./chat";
import { createChatEngine, searchMessages, transcript } from "./engine";
import { react, reactionSummary } from "./reactions";

const REACT_EMOJIS = ["👍", "❤️", "🎉", "🤔"] as const;

// Interactive local-first AI chat. History persists to ./data/ai-chat.db across
// runs; pass RELAY_URL to sync across devices.
async function main(): Promise<void> {
  const relayUrls = process.env.RELAY_URL ? [process.env.RELAY_URL] : [];
  const engine = createChatEngine({ relayUrls });
  await engine.ready;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    `Local-first AI chat — AI backend: ${aiAvailable() ? "Claude (live)" : "offline stub"}.`,
  );
  console.log("Commands: /history  /search <text>  /react <emoji>  /exit\n");

  for (const m of await transcript(engine)) {
    console.log(`${m.role === "assistant" ? "ai " : "you"} ▸ ${m.body}`);
  }

  for (;;) {
    const input = (await rl.question("you ▸ ")).trim();
    if (!input) continue;
    if (input === "/exit") break;
    if (input === "/history") {
      for (const m of await transcript(engine)) {
        console.log(`${m.role === "assistant" ? "ai " : "you"} ▸ ${m.body}`);
      }
      continue;
    }
    if (input.startsWith("/search")) {
      const q = input.slice("/search".length).trim();
      if (!q) {
        console.log("(usage: /search <text>)");
        continue;
      }
      const hits = await searchMessages(engine, q);
      if (!hits.length) console.log("(no matches)");
      for (const m of hits) {
        console.log(`${m.role === "assistant" ? "ai " : "you"} ▸ ${m.body}`);
      }
      continue;
    }
    if (input.startsWith("/react")) {
      const emoji = input.slice("/react".length).trim() || "👍";
      const lastAssistant = [...(await transcript(engine))]
        .reverse()
        .find((m) => m.role === "assistant");
      if (!lastAssistant) {
        console.log("(nothing to react to yet)");
        continue;
      }
      react(engine, lastAssistant.id, emoji);
      const summary = await reactionSummary(engine, lastAssistant.id, REACT_EMOJIS);
      console.log(
        `reactions: ${summary.map((r) => `${r.emoji} ${r.count}`).join("  ") || "(none)"}`,
      );
      continue;
    }
    process.stdout.write("ai  ▸ ");
    await sendAndReply(engine, input, {
      onStatus: (s) => {
        if (s === "thinking") process.stdout.write("thinking…");
        else if (s === "responding") process.stdout.write("\r\x1b[2Kai  ▸ ");
      },
      onToken: (t) => process.stdout.write(t),
    });
    process.stdout.write("\n");
  }

  rl.close();
}

void main();
