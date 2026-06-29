import { aiAvailable } from "./ai";
import { sendAndReply } from "./chat";
import { decodeContent, describeBlock } from "./content";
import { createChatEngine, transcript } from "./engine";

// Shows structured message content: the user message carries a text block plus
// an attachment block; the assistant reply carries a text block plus a model
// metadata block. All stored as JSON in the `content` column and decoded back.
async function main(): Promise<void> {
  const engine = createChatEngine({ dbPath: ":memory:" });
  await engine.ready;
  console.log(
    `AI backend: ${aiAvailable() ? "Claude (live)" : "offline stub"}\n`,
  );

  console.log("you ▸ Summarize the attached notes. [📎 notes.md]");
  await sendAndReply(engine, "Summarize the attached notes.", {
    attachments: [
      { name: "notes.md", mime: "text/markdown", url: "file://notes.md" },
    ],
  });

  console.log("\n— transcript with decoded content blocks —");
  for (const m of await transcript(engine)) {
    console.log(`${m.role.padEnd(9)} ${m.body}`);
    const blocks = decodeContent(m.content);
    console.log(`           content: [${blocks.map(describeBlock).join(", ")}]`);
  }
}

void main();
