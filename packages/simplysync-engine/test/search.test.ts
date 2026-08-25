import { describe, expect, test } from "bun:test";

import {
  createSync,
  escapeLikePattern,
  id,
  NonEmptyString,
  searchFilter,
  String as Str,
} from "../src/index";
import { memoryDriver, memoryStorage } from "./support";

const schema = {
  message: { id: id("Message"), author: NonEmptyString, body: Str },
};

function makeEngine() {
  return createSync({
    createSqliteDriver: () => memoryDriver().driver,
    secureStorage: memoryStorage(),
  })(schema, { name: "search-test" });
}

async function seed(engine: ReturnType<typeof makeEngine>) {
  await engine.ready;
  engine.batch([
    { table: "message", values: { author: "alice", body: "Hello world" } },
    { table: "message", values: { author: "bob", body: "goodbye world" } },
    { table: "message", values: { author: "alice", body: "Hello there" } },
    { table: "message", values: { author: "carol", body: "100% organic_food" } },
    { table: "message", values: { author: "dave", body: "one hundred apples" } },
  ]);
}

const search = async (
  engine: ReturnType<typeof makeEngine>,
  columns: string[],
  query: string,
): Promise<string[]> => {
  const rows = await engine.loadQuery(
    engine.createQuery((db) =>
      db
        .selectFrom("message")
        .select(["author", "body"])
        .where("isDeleted", "=", 0)
        .where(searchFilter(columns, query)),
    ),
  );
  return rows.map((r) => r.body as string);
};

describe("searchFilter", () => {
  test("case-insensitive single term across rows", async () => {
    const engine = makeEngine();
    await seed(engine);
    const hits = await search(engine, ["body"], "hello");
    expect(hits.sort()).toEqual(["Hello there", "Hello world"]);
  });

  test("multi-term requires all terms (AND)", async () => {
    const engine = makeEngine();
    await seed(engine);
    expect(await search(engine, ["body"], "hello world")).toEqual([
      "Hello world",
    ]);
  });

  test("matches across any of the given columns", async () => {
    const engine = makeEngine();
    await seed(engine);
    // "alice" appears only as an author, never in a body.
    const hits = await search(engine, ["author", "body"], "alice");
    expect(hits.sort()).toEqual(["Hello there", "Hello world"]);
  });

  test("escapes LIKE wildcards so % and _ match literally", async () => {
    const engine = makeEngine();
    await seed(engine);
    // "%" must match the literal percent row, not every row.
    expect(await search(engine, ["body"], "100%")).toEqual(["100% organic_food"]);
    // "_" must match the literal underscore, not any single char.
    expect(await search(engine, ["body"], "organic_food")).toEqual([
      "100% organic_food",
    ]);
    // A bare "_" would match everything if unescaped; it should match only the
    // row literally containing an underscore.
    expect((await search(engine, ["body"], "_")).length).toBe(1);
  });

  test("empty query matches everything", async () => {
    const engine = makeEngine();
    await seed(engine);
    expect((await search(engine, ["body"], "   ")).length).toBe(5);
  });

  test("no match returns nothing", async () => {
    const engine = makeEngine();
    await seed(engine);
    expect(await search(engine, ["body"], "zzz nonexistent")).toEqual([]);
  });
});

describe("escapeLikePattern", () => {
  test("escapes backslash, percent, underscore", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    expect(escapeLikePattern("plain")).toBe("plain");
  });
});
