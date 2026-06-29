// A small, self-contained type system. It provides the schema column types
// (id, NonEmptyString, SqliteBoolean, …) used to declare tables, plus runtime
// validation (`from`/`orThrow`) and the SQLite column kind used to create the
// physical tables. It is a small typed-schema DSL the shared schema and call
// sites build on.

import { isRecoveryMnemonic, normalizeMnemonic } from "@simplysync/protocol";
import { isOrderKey } from "./order";
import { isJsonString } from "./json";

declare const brandSymbol: unique symbol;
export type Brand<B extends string> = { readonly [brandSymbol]: B };
export type Branded<T, B extends string> = T & Brand<B>;

export interface TypeError {
  readonly type: string;
  readonly message: string;
  readonly value: unknown;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TypeError };

export type SqliteColumnType = "text" | "integer" | "real" | "blob";

/**
 * A schema column type. `Type` is a phantom carrier so `typeof X.Type` yields
 * the decoded TypeScript type (the `typeof X.Type` idiom).
 */
export interface Type<T> {
  /** Phantom — never read at runtime. */
  readonly Type: T;
  readonly name: string;
  readonly sqlite: SqliteColumnType;
  readonly nullable: boolean;
  from: (value: unknown) => Result<T>;
  orThrow: (value: unknown) => T;
}

const err = (type: string, message: string, value: unknown): Result<never> => ({
  ok: false,
  error: { type, message, value },
});

function makeType<T>(opts: {
  name: string;
  sqlite: SqliteColumnType;
  nullable?: boolean;
  validate: (value: unknown) => string | null;
  coerce?: (value: unknown) => T;
}): Type<T> {
  const nullable = opts.nullable ?? false;
  const from = (value: unknown): Result<T> => {
    if (value === null || value === undefined) {
      if (nullable) return { ok: true, value: null as unknown as T };
      return err(opts.name, `${opts.name} must not be null.`, value);
    }
    const message = opts.validate(value);
    if (message) return err(opts.name, message, value);
    return { ok: true, value: (opts.coerce ? opts.coerce(value) : value) as T };
  };
  return {
    Type: undefined as unknown as T,
    name: opts.name,
    sqlite: opts.sqlite,
    nullable,
    from,
    orThrow: (value: unknown): T => {
      const result = from(value);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
  };
}

// ----- Strings -----------------------------------------------------------

export const String = makeType<string>({
  name: "String",
  sqlite: "text",
  validate: (v) => (typeof v === "string" ? null : "Expected a string."),
});

export type NonEmptyString = string;
export const NonEmptyString = makeType<string>({
  name: "NonEmptyString",
  sqlite: "text",
  validate: (v) =>
    typeof v !== "string"
      ? "Expected a string."
      : v.length === 0
        ? "Expected a non-empty string."
        : null,
});

export type NonEmptyString1000 = string;
export const NonEmptyString1000 = makeType<string>({
  name: "NonEmptyString1000",
  sqlite: "text",
  validate: (v) =>
    typeof v !== "string"
      ? "Expected a string."
      : v.length === 0 || v.length > 1000
        ? "Expected a string of 1–1000 characters."
        : null,
});

/** Wraps a string type with a maximum length (`maxLength`). */
export const maxLength =
  (max: number) =>
  <T extends string>(base: Type<T>): Type<T> =>
    makeType<T>({
      name: `${base.name}Max${max}`,
      sqlite: base.sqlite,
      validate: (v) => {
        const result = base.from(v);
        if (!result.ok) return result.error.message;
        if (typeof v === "string" && v.length > max)
          return `Expected at most ${max} characters.`;
        return null;
      },
    });

// ----- Numbers -----------------------------------------------------------

export type PositiveInt = number;
export const PositiveInt = makeType<number>({
  name: "PositiveInt",
  sqlite: "integer",
  validate: (v) =>
    typeof v !== "number" || !Number.isInteger(v) || v <= 0
      ? "Expected a positive integer."
      : null,
});

export type FiniteNumber = number;
export const FiniteNumber = makeType<number>({
  name: "FiniteNumber",
  sqlite: "real",
  validate: (v) =>
    typeof v !== "number" || !Number.isFinite(v)
      ? "Expected a finite number."
      : null,
});

// ----- SQLite boolean (0 | 1) -------------------------------------------

export type SqliteBoolean = number;
export const SqliteBoolean = makeType<number>({
  name: "SqliteBoolean",
  sqlite: "integer",
  validate: (v) =>
    v === 0 || v === 1 ? null : "Expected a SQLite boolean (0 or 1).",
});
export const sqliteTrue = 1 as SqliteBoolean;
export const sqliteFalse = 0 as SqliteBoolean;

// ----- Nullability -------------------------------------------------------

/** Makes a column type accept `null` (`nullOr`). */
export const nullOr = <T>(base: Type<T>): Type<T | null> =>
  makeType<T | null>({
    name: `${base.name}OrNull`,
    sqlite: base.sqlite,
    nullable: true,
    validate: (v) => {
      const result = base.from(v);
      return result.ok ? null : result.error.message;
    },
  });

// ----- Ids ---------------------------------------------------------------

export type Id = string;

/**
 * An id type for a table, e.g. `id("Account")`. Values are opaque, stable
 * strings. Kept unbranded so query
 * results and mutation inputs interoperate with plain string ids the way the
 * call sites are written.
 */
export const id = <Table extends string>(table: Table): Type<string> =>
  makeType<string>({
    name: `${table}Id`,
    sqlite: "text",
    validate: (v) =>
      typeof v === "string" && v.length > 0 ? null : "Expected an id string.",
  });

// ----- JSON-valued column ------------------------------------------------

export type JsonText = string;
/**
 * A column holding JSON-encoded structured data (arrays/objects). Stored as
 * text; write values with `encodeJson` and read them with `decodeJsonOr` /
 * `decodeJson` (from `./json`). Wrap with `nullOr(JsonText)` for an optional
 * column. The decoded value is a string by design — the helpers carry the
 * typed shape — so the type system never claims a parsed object it can't return
 * from a raw query row.
 */
export const JsonText = makeType<string>({
  name: "JsonText",
  sqlite: "text",
  validate: (v) =>
    isJsonString(v)
      ? null
      : "Expected a JSON string (serialize with encodeJson).",
});

// ----- Fractional index (ordering key) ----------------------------------

export type FractionalIndex = string;
/**
 * An ordering key for reorderable lists (todos, chat/threads, kanban). Stored as
 * text and sorted lexicographically; mint values with `keyBetween` /
 * `keysBetween` from `./order`. Sorting in SQL should be `order by <col>, id` to
 * match `compareOrderKeys`' tie-break.
 */
export const FractionalIndex = makeType<string>({
  name: "FractionalIndex",
  sqlite: "text",
  validate: (v) =>
    isOrderKey(v) ? null : "Expected a fractional index key.",
});

// ----- Service name & Mnemonic ------------------------------------------

export type SimpleName = string;
export const SimpleName = makeType<string>({
  name: "SimpleName",
  sqlite: "text",
  validate: (v) =>
    typeof v === "string" && /^[a-z0-9-]{1,64}$/iu.test(v)
      ? null
      : "Expected a simple name ([A-Za-z0-9-], 1–64 chars).",
});

export type Mnemonic = string;
export const Mnemonic = makeType<string>({
  name: "Mnemonic",
  sqlite: "text",
  validate: (v) =>
    typeof v === "string" && isRecoveryMnemonic(v)
      ? null
      : "Expected a valid BIP39 recovery phrase.",
  coerce: (v) => normalizeMnemonic(v as string),
});

// ----- Re-export base64url helpers used by call sites --------------------

export {
  base64UrlEncode as uint8ArrayToBase64Url,
  base64UrlDecode,
} from "@simplysync/protocol";
