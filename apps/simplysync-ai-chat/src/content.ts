import { decodeJsonOr, encodeJson } from "@simplysync/engine";

// Structured message content stored in the `content` JSON column, alongside the
// plain-text `body` (which stays the searchable/renderable fallback). Real AI
// chats carry more than text — attachments, tool calls, and per-reply metadata —
// so model them as typed blocks and (de)serialize at the boundary.
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "attachment"; name: string; mime?: string; url?: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "model"; model: string };

/** Serialize content blocks for the `content` column. */
export const encodeContent = (blocks: ContentBlock[]): string =>
  encodeJson(blocks);

/** Decode content blocks; returns `[]` for null/missing/corrupt data (never throws). */
export const decodeContent = (json: string | null | undefined): ContentBlock[] =>
  decodeJsonOr<ContentBlock[]>(json, []);

/** A short human-readable label for a content block. */
export function describeBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return `text(${block.text.length} chars)`;
    case "attachment":
      return `attachment(${block.name})`;
    case "tool_use":
      return `tool_use(${block.name})`;
    case "model":
      return `model(${block.model})`;
  }
}
