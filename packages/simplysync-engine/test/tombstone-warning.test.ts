import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createSync,
  id,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
} from "../src/index";

function makeDriver(): SqliteDriver {
  const db = new Database(":memory:");
  return {
    exec(sql, params) {
      db.prepare(sql).run(...((params ?? []) as never[]));
    },
    select(sql, params) {
      return db.prepare(sql).all(...((params ?? []) as never[])) as never;
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
  };
}

function memoryStorage(): SecureStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const schema = {
  note: { id: id("Note"), body: NonEmptyString },
};

// Each test builds a distinct SQL string: the warning is deduped by SQL text
// process-wide, so reusing one would make the second assertion pass vacuously.
function makeEngine() {
  return createSync({
    createSqliteDriver: () => makeDriver(),
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
