import { counterTotalQuery, incrementCounter } from "@simplysync/engine";
import type { ChatEngine } from "./engine";

// Reactions are conflict-free counters keyed by "<messageId>:<emoji>". Each tap
// appends a delta row, so two devices liking the same message at once never lose
// a count under last-writer-wins — unlike a single integer column.

const key = (messageId: string, emoji: string) => `${messageId}:${emoji}`;

/** Add one reaction. Safe to call rapidly / from multiple devices. */
export function react(engine: ChatEngine, messageId: string, emoji: string) {
  return incrementCounter(engine, "reaction", key(messageId, emoji));
}

/** Current count for one (message, emoji) reaction. */
export async function reactionCount(
  engine: ChatEngine,
  messageId: string,
  emoji: string,
): Promise<number> {
  const rows = await engine.loadQuery(
    counterTotalQuery(engine, "reaction", key(messageId, emoji)),
  );
  return rows[0]?.total ?? 0;
}

/** Counts for a set of emoji on one message (omitting zero counts). */
export async function reactionSummary(
  engine: ChatEngine,
  messageId: string,
  emojis: readonly string[],
): Promise<Array<{ emoji: string; count: number }>> {
  const counts = await Promise.all(
    emojis.map(async (emoji) => ({
      emoji,
      count: await reactionCount(engine, messageId, emoji),
    })),
  );
  return counts.filter((c) => c.count > 0);
}
