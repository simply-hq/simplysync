import { keysBetween } from "@simplysync/engine";
import { createChatEngine, searchMessages } from "./engine";

// Shows transcript search via the engine's composable LIKE predicate
// (case-insensitive, multi-term). Seeds a few messages in one atomic batch.
async function main(): Promise<void> {
  const engine = createChatEngine({ dbPath: ":memory:" });
  await engine.ready;

  const bodies = [
    "Tell me about Paris",
    "What's the weather today?",
    "Recommend a cozy Paris cafe",
    "How do I center a div in CSS?",
  ];
  const orders = keysBetween(null, null, bodies.length);
  engine.batch(
    bodies.map((body, i) => ({
      table: "message" as const,
      values: { role: "user", body, order: orders[i]! },
    })),
  );

  for (const query of ["paris", "css div", "weather"]) {
    const hits = await searchMessages(engine, query);
    console.log(`search "${query}" → ${hits.length} hit(s):`);
    for (const m of hits) console.log(`  • ${m.body}`);
  }
  console.log("\n(case-insensitive; multi-term requires all terms to match.)");
}

void main();
