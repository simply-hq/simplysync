// Text search: find messages, notes, or todos containing what the user typed.
//
// Deliberately built on plain `LIKE`, not SQLite FTS5. FTS5 is faster and
// supports ranking, but it isn't compiled into every platform's SQLite build
// (bun:sqlite / expo-sqlite / the native iOS+Android drivers vary), and an FTS5
// virtual table doesn't fit the synced-schema model — it would have to be a
// local-only derived index rebuilt on the sync apply path. A `LIKE` predicate
// works on every SQLite build and against the rows the engine already syncs.
// For personal-app data sizes (thousands of rows) it's plenty; revisit FTS5 as
// an opt-in optimization on platforms that have it.
//
// `searchFilter` returns a WHERE predicate you drop into your OWN typed query,
// so the result keeps your table's row type and you stay in control of
// ordering, pagination, and the soft-delete filter:
//
//   const q = engine.createQuery((db) =>
//     db.selectFrom("message")
//       .selectAll()
//       .where("isDeleted", "=", 0)
//       .where(searchFilter(["body", "author"], input))
//       .orderBy("order"),
//   );
//
// Matching: the query is split on whitespace into terms; a row matches when
// EVERY term appears (case-insensitively) in AT LEAST ONE of the given columns.
// An empty query matches everything (no filtering), which is the usual
// search-box behaviour. Case folding uses SQLite `lower()`, which is ASCII-only
// unless an ICU build is loaded.

import {
  sql,
  type Expression,
  type ExpressionBuilder,
  type SqlBool,
} from "kysely";

/**
 * Escape the `LIKE` metacharacters (`\` `%` `_`) in user input so they match
 * literally instead of as wildcards — otherwise a user typing "100%" or
 * "foo_bar" would match far more than they meant. Pairs with `escape '\'` in
 * the generated SQL.
 */
export const escapeLikePattern = (input: string): string =>
  input.replace(/[\\%_]/gu, (ch) => `\\${ch}`);

/**
 * Build a case-insensitive, multi-term, multi-column text-search predicate for
 * use in a Kysely `.where(...)`. See the module comment for usage and matching
 * semantics. `columns` are developer-supplied identifiers (not user input);
 * the search text is always passed as a bound parameter.
 */
export const searchFilter =
  (columns: readonly string[], query: string) =>
  // The host query owns the real column typing; this predicate is column-name
  // dynamic, so it takes a permissive expression builder. It still slots into a
  // fully-typed `.where(...)` on the caller's side.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic columns
  (eb: ExpressionBuilder<any, any>): Expression<SqlBool> => {
    const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    if (terms.length === 0 || columns.length === 0) {
      return sql<SqlBool>`1 = 1`; // empty query -> match all
    }
    return eb.and(
      terms.map((term) => {
        const pattern = `%${escapeLikePattern(term)}%`;
        return eb.or(
          columns.map(
            (col) =>
              sql<SqlBool>`lower(${sql.ref(col)}) like ${pattern} escape '\\'`,
          ),
        );
      }),
    );
  };
