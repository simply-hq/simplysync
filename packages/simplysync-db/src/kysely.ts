// Re-export Kysely (plus SQLite JSON helpers) as a namespace so call sites can
// use `kysely.sql`, `kysely.NotNull`, `kysely.jsonObjectFrom`, etc.
export * as kysely from "./kysely-ns";
export { sql, Kysely } from "kysely";
export type { NotNull } from "kysely";
