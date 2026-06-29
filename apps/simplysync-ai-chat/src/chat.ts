import { modelLabel, streamReply, type ChatTurn } from "./ai";
import { encodeContent, type ContentBlock } from "./content";
import { nextOrder, transcript, type ChatEngine } from "./engine";

/** An attachment to send alongside a user message (stored as a content block). */
export interface Attachment {
  name: string;
  mime?: string;
  url?: string;
}

/**
 * Send a user message and stream an assistant reply — the local-first AI-chat
 * pattern on @simplysync/engine:
 *
 *  1. Insert the user message (one synced event).
 *  2. Insert an empty assistant message to render the reply into.
 *  3. Stream tokens into that row with `{ local: true }` — each token updates the
 *     local DB and any live query INSTANTLY, but does NOT enqueue a sync event,
 *     so a 500-token reply doesn't push 500 soon-superseded events to the relay.
 *  4. Commit once at the end with a normal write — peers receive a single event
 *     carrying the finished message.
 *
 * `onToken` is called for each streamed token (e.g. to print to a terminal).
 */
/** AI lifecycle for one turn — drive an "AI is thinking…" presence indicator. */
export type ChatStatus = "thinking" | "responding" | "idle";

export interface SendOptions {
  /** Called for each streamed token (e.g. to print to a terminal). */
  onToken?: (token: string) => void;
  /** Called as the assistant moves thinking → responding → idle. Wire this to a
   *  presence channel so other devices see "the assistant is thinking…". */
  onStatus?: (status: ChatStatus) => void;
  /** Attachments to attach to the user message (stored as content blocks). */
  attachments?: readonly Attachment[];
}

export async function sendAndReply(
  engine: ChatEngine,
  userText: string,
  opts: SendOptions = {},
): Promise<string> {
  const { onToken, onStatus, attachments } = opts;
  const userOrder = await nextOrder(engine);
  const userBlocks: ContentBlock[] = [
    { type: "text", text: userText },
    ...(attachments ?? []).map(
      (a): ContentBlock => ({ type: "attachment", ...a }),
    ),
  ];
  const sent = engine.insert("message", {
    role: "user",
    body: userText,
    order: userOrder,
    content: encodeContent(userBlocks),
  });
  if (!sent.ok) throw new Error(`failed to send: ${sent.error.message}`);

  const replyOrder = await nextOrder(engine);
  const reply = engine.insert("message", {
    role: "assistant",
    body: "",
    order: replyOrder,
  });
  if (!reply.ok) throw new Error(`failed to create reply: ${reply.error.message}`);
  const replyId = reply.value.id;

  const history: ChatTurn[] = (await transcript(engine))
    .filter((m) => m.id !== replyId) // exclude the empty placeholder
    .map((m) => ({ role: m.role as ChatTurn["role"], text: m.body }));

  // "thinking" until the first token arrives, then "responding".
  onStatus?.("thinking");
  let body = "";
  try {
    for await (const token of streamReply(history)) {
      if (body === "") onStatus?.("responding");
      body += token;
      // Local-only write: live UI updates, no relay flood.
      engine.update("message", { id: replyId, body }, { local: true });
      onToken?.(token);
    }
    // Commit the finished reply -> exactly one replicated event. The structured
    // content records the text plus which model produced it.
    engine.update("message", {
      id: replyId,
      body,
      content: encodeContent([
        { type: "text", text: body },
        { type: "model", model: modelLabel() },
      ]),
    });
  } finally {
    onStatus?.("idle");
  }
  return body;
}
