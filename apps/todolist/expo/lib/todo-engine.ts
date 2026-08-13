// This is the React Native face of the canonical cross-platform todo example.
// Keep these three columns wire-compatible with:
//   TypeScript  apps/todolist/cli/src/schema.ts
//   Swift       apps/todolist/swift/SimplySyncDemo/AppSchema.swift
//   Kotlin      apps/todolist/kotlin/.../EngineTest.kt

import {
  createSync,
  id,
  NonEmptyString,
  SqliteBoolean,
  type QueryRow,
  type Transport,
} from "@simplysync/engine";
import { createExpoSyncDeps } from "@simplysync/react-native";

const todoSchema = {
  todo: {
    id: id("todo"),
    title: NonEmptyString,
    done: SqliteBoolean,
  },
};

// A fresh app is useful before the builder chooses or deploys a relay. Add a
// URL here (10.0.2.2 for an Android emulator, localhost for iOS) or enter one
// in the app settings when this device should begin syncing.
export const DEFAULT_RELAY_URL =
  process.env.EXPO_PUBLIC_SIMPLYSYNC_RELAY_URL?.trim() ?? "";

export const ONBOARDING_COMPLETE_KEY =
  "simplysync-todos.recovery-confirmed";

export function relayTransport(url: string): Transport | null {
  const normalized = url.trim().replace(/\/+$/u, "");
  return normalized ? { type: "Http", url: normalized } : null;
}

const defaultTransport = relayTransport(DEFAULT_RELAY_URL);

export const todoEngine = createSync(
  createExpoSyncDeps({
    sqlite: {
      openOptions: { enableChangeListener: true },
    },
    sqlCipher: {},
  }),
)(todoSchema, {
  name: "simplysync-todos",
  transports: defaultTransport ? [defaultTransport] : [],
});

export const activeTodos = todoEngine.createQuery((db) =>
  db
    .selectFrom("todo")
    .select(["id", "title", "done", "updatedAt"])
    .where("isDeleted", "=", 0)
    .orderBy("updatedAt", "desc")
    .orderBy("id", "desc"),
);

export type TodoRow = QueryRow<typeof activeTodos>;
