import { expect, test } from "bun:test";
import { readOutboxDiagnostics, type RawRow } from "./internals";

test("outbox counts are independent of the eight-row recent-events preview", () => {
  const recent = Array.from({ length: 8 }, (_, index) => ({
    event_id: `event-${index}`,
  }));

  const diagnostics = readOutboxDiagnostics((sql): RawRow[] => {
    if (sql.includes("where pushed_at is null")) return [{ c: 12 }];
    if (sql.includes("count(*)")) return [{ c: 14 }];
    if (sql.includes("limit 8")) return recent;
    throw new Error(`Unexpected query: ${sql}`);
  });

  expect(diagnostics.recent).toHaveLength(8);
  expect(diagnostics.pending).toBe(12);
  expect(diagnostics.total).toBe(14);
});
