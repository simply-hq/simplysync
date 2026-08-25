import { afterEach, describe, expect, test } from "bun:test";

import {
  createSync,
  id,
  NonEmptyString,
} from "../src/index";
import { memoryDriver, memoryStorage } from "./support";

const schema = {
  note: { id: id("Note"), body: NonEmptyString },
};

// Each test builds a distinct SQL string: the warning is deduped by SQL text
// process-wide, so reusing one would make the second assertion pass vacuously.
function makeEngine() {
  return createSync({
    createSqliteDriver: () => memoryDriver().driver,
    secureStorage: memoryStorage(),
  })(schema, { name: "tombstone-warning-test" });
}

const original = console.warn;
let warnings: string[] = [];

function captureWarnings(): void {
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
}

afterEach(() => {
  console.warn = original;
});

describe("missing isDeleted filter warning", () => {
  test("warns when a query can return soft-deleted rows", () => {
    const engine = makeEngine();
    captureWarnings();
    engine.createQuery((db) => db.selectFrom("note").select("id"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("note");
    expect(warnings[0]).toContain("isDeleted");
  });

  test("selecting isDeleted without filtering it still warns", () => {
    const engine = makeEngine();
    captureWarnings();
    engine.createQuery((db) =>
      db.selectFrom("note").select(["id", "body", "isDeleted"]),
    );
    expect(warnings).toHaveLength(1);
  });

  test("stays quiet when the query filters tombstones", () => {
    const engine = makeEngine();
    captureWarnings();
    engine.createQuery((db) =>
      db.selectFrom("note").select("body").where("isDeleted", "=", 0),
    );
    expect(warnings).toEqual([]);
  });

  test("stays quiet when includeDeleted acknowledges the read", () => {
    const engine = makeEngine();
    captureWarnings();
    engine.createQuery((db) => db.selectFrom("note").select("body"), {
      includeDeleted: true,
    });
    expect(warnings).toEqual([]);
  });

  test("warns only once for a repeated query", () => {
    const engine = makeEngine();
    captureWarnings();
    const build = () =>
      engine.createQuery((db) => db.selectFrom("note").select(["id", "body"]));
    build();
    build();
    build();
    expect(warnings).toHaveLength(1);
  });
});
