// The canonical cross-platform example schema.
//
// The SAME three columns are declared in the Swift and Kotlin ports, so one
// owner's data is readable by every client:
//
//   TypeScript  apps/todolist/cli/src/schema.ts                    (this file)
//   Swift       apps/todolist/swift/SimplySyncDemo/AppSchema.swift
//   Kotlin      apps/todolist/kotlin/src/test/kotlin/.../EngineTest.kt
//
// Changing a column here without changing the other two makes the platforms
// disagree — `bun run todo:interop` is what catches that.

import { id, NonEmptyString, SqliteBoolean } from "@simplysync/engine";

export const todoSchema = {
  todo: {
    id: id("todo"),
    title: NonEmptyString,
    done: SqliteBoolean,
  },
};

export type TodoSchema = typeof todoSchema;

/** One decoded todo row. Mirrors Swift's `TodoRow` and Kotlin's `TodoRow`. */
export interface TodoRow {
  readonly id: string;
  readonly title: string;
  readonly done: number;
  readonly updatedAt: string;
}
