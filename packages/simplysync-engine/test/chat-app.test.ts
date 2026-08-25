// Reference scenario: a local-first CHAT / AI-chat app built end-to-end on the
// engine. Exercises ordered messages, a token-by-token streamed assistant reply
// (local writes that don't flood the relay), conflict-free reaction + unread
// counters, structured message content, search, edit, and delete — doubling as
// living documentation that the API fits this use case.

import { describe, expect, test } from "bun:test";

import {
  counterColumns,
  counterTotalQuery,
  createSync,
  decodeJsonOr,
  encodeJson,
  FractionalIndex,
  id,
  incrementCounter,
  keyBetween,
  NonEmptyString,
  nullOr,
  JsonText,
  searchFilter,
  String as Str,
} from "../src/index";
import { memoryDriver, memoryStorage, settle } from "./support";

const schema = {
  message: {
    id: id("Message"),
    role: NonEmptyString, // "user" | "assistant"
    body: Str,
    order: FractionalIndex,
    content: nullOr(JsonText), // structured content blocks / tool calls
  },
  reaction: counterColumns(), // conflict-free per-message tallies
};

function makeApp() {
  return createSync({
    createSqliteDriver: () => memoryDriver().driver,
    secureStorage: memoryStorage(),
  })(schema, { name: "chat-app" });
}

type Engine = ReturnType<typeof makeApp>;

const transcript = (engine: Engine) =>
  engine.loadQuery(
    engine.createQuery((db) =>
      db
        .selectFrom("message")
        .select(["id", "role", "body", "order"])
        .where("isDeleted", "=", 0)
        .orderBy("order")
        .orderBy("id"),
    ),
  );


const lastOrder = async (engine: Engine): Promise<string | null> => {
  const rows = await transcript(engine);
  return rows.length ? (rows[rows.length - 1]!.order as string) : null;
};

const send = async (engine: Engine, role: string, body: string) => {
  const order = keyBetween(await lastOrder(engine), null);
  return engine.insert("message", { role, body, order });
};

describe("chat app", () => {
  test("conversation with a streamed AI reply, reactions, search, edit, delete", async () => {
    const engine = makeApp();
    await engine.ready;

    // User asks a question.
    const q = await send(engine, "user", "What's the capital of France?");
    expect(q.ok).toBe(true);
    await settle(engine);
    const afterUser = engine.getPendingOutboxCount();

    // Assistant message is created empty, then streamed token-by-token with
    // local-only writes (no relay flood), and committed once when complete.
    const order = keyBetween(await lastOrder(engine), null);
    const reply = engine.insert("message", { role: "assistant", body: "", order });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;

    const tokens = ["The", " capital", " of", " France", " is", " Paris", "."];
    let streamed = "";
    for (const tok of tokens) {
      streamed += tok;
      engine.update("message", { id: reply.value.id, body: streamed }, { local: true });
    }
    await settle(engine);
    // Streaming added NO sync events beyond the user message + the empty reply.
    expect(engine.getPendingOutboxCount()).toBe(afterUser + 1);

    // Commit the finished reply -> exactly one replicated event.
    engine.update("message", { id: reply.value.id, body: streamed });
    await settle(engine);
    expect(engine.getPendingOutboxCount()).toBe(afterUser + 2);

    // Transcript is in order and shows the full streamed text.
    const convo = await transcript(engine);
    expect(convo.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(convo[1]!.body).toBe("The capital of France is Paris.");

    // Reactions are conflict-free counters — many bumps never lose an update.
    for (let i = 0; i < 5; i++)
      incrementCounter(engine, "reaction", `${reply.value.id}:thumbsup`);
    const likes = await engine.loadQuery(
      counterTotalQuery(engine, "reaction", `${reply.value.id}:thumbsup`),
    );
    expect(likes[0]?.total).toBe(5);

    // Store structured content blocks for the assistant message.
    engine.update("message", {
      id: reply.value.id,
      content: encodeJson([{ type: "text", text: streamed }]),
    });
    const withContent = await engine.loadQuery(
      engine.createQuery(
        (db) =>
          db
            .selectFrom("message")
            .select(["content"])
            .where("id", "=", reply.value.id),
        { includeDeleted: true },
      ),
    );
    expect(
      decodeJsonOr<{ type: string; text: string }[]>(withContent[0]?.content, []),
    ).toEqual([{ type: "text", text: streamed }]);

    // Search the transcript.
    const found = await engine.loadQuery(
      engine.createQuery((db) =>
        db
          .selectFrom("message")
          .select(["body"])
          .where("isDeleted", "=", 0)
          .where(searchFilter(["body"], "paris")),
      ),
    );
    expect(found.map((m) => m.body)).toEqual(["The capital of France is Paris."]);

    // Edit the user's question.
    engine.update("message", { id: q.value!.id, body: "Capital of France?" });
    // Delete the assistant reply (soft delete -> drops out of the transcript).
    engine.delete("message", reply.value.id);
    const afterDelete = await transcript(engine);
    expect(afterDelete.map((m) => m.body)).toEqual(["Capital of France?"]);
  });
});
