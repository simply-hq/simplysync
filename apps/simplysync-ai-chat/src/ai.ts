import Anthropic from "@anthropic-ai/sdk";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

// Default to the most capable model; override with CLAUDE_MODEL.
const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-4-8";

const SYSTEM =
  "You are a concise, helpful assistant inside a local-first chat app. " +
  "Answer directly and keep replies short unless asked for detail.";

/** True when a real Claude reply is possible (an API key is configured). */
export const aiAvailable = (): boolean => !!process.env.ANTHROPIC_API_KEY;

/** The model that produced (or would produce) replies — for content metadata. */
export const modelLabel = (): string => (aiAvailable() ? MODEL : "offline-stub");

/**
 * Stream an assistant reply token-by-token for the given conversation history.
 * Uses the Claude Messages API when `ANTHROPIC_API_KEY` is set; otherwise yields
 * a streamed offline stub so the example runs (and demonstrates the engine's
 * streaming-write path) without credentials.
 */
export async function* streamReply(history: ChatTurn[]): AsyncGenerator<string> {
  if (!aiAvailable()) {
    yield* stubReply(history);
    return;
  }
  const client = new Anthropic();
  const messages = history.map((t) => ({ role: t.role, content: t.text }));
  const base = { model: MODEL, max_tokens: 1024, system: SYSTEM, messages };

  // FAST=1 opts into Fast Mode: the same model at up to ~2.5x output tokens/sec
  // (Claude Opus 4.8, beta + premium pricing). It needs the beta messages endpoint,
  // the beta flag, and speed:"fast". Otherwise use the standard streaming endpoint.
  // Streaming (both paths) avoids HTTP timeouts on long replies.
  if (process.env.FAST === "1") {
    const stream = client.beta.messages.stream({
      ...base,
      speed: "fast",
      betas: ["fast-mode-2026-02-01"],
    });
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
    return;
  }

  const stream = client.messages.stream(base);
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}

async function* stubReply(history: ChatTurn[]): AsyncGenerator<string> {
  const lastUser =
    [...history].reverse().find((t) => t.role === "user")?.text ?? "";
  const reply =
    `Offline stub reply. You said: "${lastUser}". ` +
    `Set ANTHROPIC_API_KEY to stream a real Claude (${MODEL}) response.`;
  for (const token of reply.match(/\S+\s*/gu) ?? []) {
    yield token;
    await new Promise((r) => setTimeout(r, 10)); // simulate token cadence
  }
}
