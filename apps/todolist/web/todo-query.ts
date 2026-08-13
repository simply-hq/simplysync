import type { Query, SyncEngine } from "@simplysync/engine";
import type { TodoSchema } from "./schema";

export type TodoRow = {
  id: string;
  title: string;
  done: number;
};

// Creation order is part of the demo's interaction contract: editing or
// completing a row must not move the control out from under the pointer.
export function createTodoListQuery(
  engine: SyncEngine<TodoSchema>,
): Query<TodoRow> {
  return engine.createQuery((db) =>
    db
      .selectFrom("todo")
      .select(["id", "title", "done"])
      .where("isDeleted", "=", 0)
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc"),
  );
}
