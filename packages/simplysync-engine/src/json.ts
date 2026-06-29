// JSON-valued columns: store structured data — arrays, objects, nested shapes —
// in a single column. Todo tags and subtasks, AI message content blocks and
// tool calls, chat attachment metadata, per-app settings blobs.
//
// SQLite has no object type, and the engine's read path returns raw column
// values (queries are arbitrary Kysely with joins/aliases, so it can't know
// which result columns to auto-parse). JSON columns are therefore stored as
// text and (de)serialized explicitly at the call site: write `encodeJson(v)`,
// read `decodeJsonOr(row.col, fallback)`. The type system stays honest — the
// column's value really is a string — while the helpers carry the typed shape.
// Declare such a column with the `JsonText` type (in ./type).
//
// For large payloads prefer the blob API: a JSON column lives inline in the
// row's sync event, so very large values make large events.

/** True if `value` is a string that parses as JSON. */
export const isJsonString = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Serialize a value to a JSON string for storage in a `JsonText` column. Throws
 * if the value isn't JSON-serializable (a cycle, a BigInt, or a top-level
 * `undefined`) — caught at the write instead of silently corrupting the row.
 */
export const encodeJson = (value: unknown): string => {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (caught) {
    throw new Error(
      `encodeJson: value is not JSON-serializable: ${
        caught instanceof Error ? caught.message : String(caught)
      }`,
    );
  }
  if (json === undefined)
    throw new Error("encodeJson: value is not JSON-serializable (undefined)");
  return json;
};

/**
 * Parse a JSON string written by `encodeJson`. Throws on malformed input — use
 * only when you trust the source. For synced data that a buggy or older peer
 * might have written, prefer `decodeJsonOr`.
 */
export const decodeJson = <T>(text: string): T => JSON.parse(text) as T;

/**
 * Parse a JSON string, returning `fallback` for null / undefined / malformed
 * input instead of throwing. The safe choice for reading synced data — a single
 * bad row can't crash the app.
 */
export const decodeJsonOr = <T>(
  text: string | null | undefined,
  fallback: T,
): T => {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};
