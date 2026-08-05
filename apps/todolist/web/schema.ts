// The canonical cross-platform example schema. Keep these three columns aligned
// with the TypeScript CLI, Swift, Kotlin, and React Native todo clients. The
// engine adds isDeleted/createdAt/updatedAt system columns automatically.

import { id, NonEmptyString, SqliteBoolean } from "@simplysync/engine";

export const DB_NAME = "simplysync-todolist-web";

export const schema = {
  todo: {
    id: id("todo"),
    title: NonEmptyString,
    done: SqliteBoolean,
  },
};

export type TodoSchema = typeof schema;
