// The playground's demo schema: a small relational ledger — money entries, each
// optionally tagged with a category. The engine adds the system columns (id is
// declared here; isDeleted/createdAt/updatedAt are implicit) — see
// packages/simplysync-engine/src/engine.ts.

import { FiniteNumber, id, NonEmptyString, nullOr } from "@simplysync/engine";

export const DB_NAME = "simplysync-playground";

export const schema = {
  category: {
    id: id("category"),
    name: NonEmptyString,
  },
  entry: {
    id: id("entry"),
    description: NonEmptyString,
    amountCents: FiniteNumber,
    categoryId: nullOr(id("category")),
  },
};

export type PlaygroundSchema = typeof schema;
