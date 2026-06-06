// The playground's demo schema: a single ledger of money entries, mirroring the
// Expo finance demo. The engine adds the system columns (id is declared here;
// isDeleted/createdAt/updatedAt are implicit) — see
// packages/simplysync-engine/src/engine.ts.

import { FiniteNumber, id, NonEmptyString } from "@simplysync/engine";

export const DB_NAME = "simplysync-playground";

export const schema = {
  entry: {
    id: id("entry"),
    description: NonEmptyString,
    amountCents: FiniteNumber,
  },
};

export type PlaygroundSchema = typeof schema;
