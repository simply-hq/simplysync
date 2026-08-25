import { describe, expect, test } from "bun:test";

import {
  createSync,
  decodeJson,
  decodeJsonOr,
  encodeJson,
  id,
  JsonText,
  NonEmptyString,
  nullOr,
} from "../src/index";
import { memoryDriver, memoryStorage } from "./support";

describe("json helpers", () => {
  test("round-trips arrays, objects, nested shapes, primitives", () => {
    for (const value of [
      ["work", "urgent"],
      { type: "text", text: "hi", meta: { tokens: 3 } },
      [{ a: 1 }, { b: [2, 3] }],
      "plain string",
      42,
      true,
      null,
    ]) {
      expect(decodeJson(encodeJson(value))).toEqual(value);
    }
  });

  test("encodeJson throws on non-serializable input", () => {
    expect(() => encodeJson(undefined)).toThrow();
    expect(() => encodeJson(10n)).toThrow(); // BigInt
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeJson(cyclic)).toThrow();
  });

  test("decodeJsonOr returns the fallback for null/undefined/malformed", () => {
    expect(decodeJsonOr<string[]>(null, [])).toEqual([]);
    expect(decodeJsonOr<string[]>(undefined, [])).toEqual([]);
    expect(decodeJsonOr<string[]>("{not json", ["fallback"])).toEqual([
      "fallback",
    ]);
    expect(decodeJsonOr<string[]>('["ok"]', [])).toEqual(["ok"]);
  });
});

describe("JsonText column type", () => {
  test("accepts JSON strings, rejects non-JSON", () => {
    expect(JsonText.from(encodeJson(["a", "b"])).ok).toBe(true);
    expect(JsonText.from('{"x":1}').ok).toBe(true);
    expect(JsonText.from("not json").ok).toBe(false);
    expect(JsonText.from(123).ok).toBe(false);
    expect(JsonText.sqlite).toBe("text");
  });

  test("stores and reads structured data end-to-end", async () => {
    const schema = {
      todo: {
        id: id("Todo"),
        title: NonEmptyString,
        tags: JsonText,
        subtasks: nullOr(JsonText),
      },
    };
    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
    })(schema, { name: "json-test" });
    await engine.ready;

    const created = engine.insert("todo", {
      title: "ship",
      tags: encodeJson(["work", "urgent"]),
      subtasks: encodeJson([{ text: "write", done: true }]),
    });
    expect(created.ok).toBe(true);

    const rows = await engine.loadQuery(
      engine.createQuery((db) => db.selectFrom("todo").select(["tags", "subtasks"]), {
        includeDeleted: true,
      }),
    );
    expect(decodeJsonOr<string[]>(rows[0]?.tags, [])).toEqual([
      "work",
      "urgent",
    ]);
    expect(
      decodeJsonOr<{ text: string; done: boolean }[]>(rows[0]?.subtasks, []),
    ).toEqual([{ text: "write", done: true }]);
  });

  test("rejects a non-JSON string at the write boundary", async () => {
    const schema = {
      note: { id: id("Note"), data: JsonText },
    };
    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
    })(schema, { name: "json-reject-test" });
    await engine.ready;
    const bad = engine.insert("note", { data: "raw, not encoded" } as never);
    expect(bad.ok).toBe(false);
  });
});
