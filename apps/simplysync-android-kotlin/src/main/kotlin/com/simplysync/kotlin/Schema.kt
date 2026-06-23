package com.simplysync.kotlin

/**
 * A schema column type — the Kotlin port of the engine's typed-schema DSL
 * (`id`, `NonEmptyString`, `FiniteNumber`, `nullOr`, …). Each column knows its
 * SQLite storage kind and how to validate a value on write. `validate` is only
 * handed a non-null value; nullability is enforced separately.
 */
class Column(
    val name: String,
    val sqlite: String, // "text" | "integer" | "real" | "blob"
    val nullable: Boolean = false,
    val validate: (JsonValue) -> String?,
) {
    companion object {
        val string = Column("String", "text") { v ->
            if (v is JsonValue.Str) null else "Expected a string."
        }
        val nonEmptyString = Column("NonEmptyString", "text") { v ->
            val s = (v as? JsonValue.Str)?.value ?: return@Column "Expected a string."
            if (s.isEmpty()) "Expected a non-empty string." else null
        }
        val nonEmptyString1000 = Column("NonEmptyString1000", "text") { v ->
            val s = (v as? JsonValue.Str)?.value ?: return@Column "Expected a string."
            if (s.isEmpty() || s.length > 1000) "Expected a string of 1–1000 characters." else null
        }
        val positiveInt = Column("PositiveInt", "integer") { v ->
            if (v is JsonValue.IntVal && v.value > 0) null else "Expected a positive integer."
        }
        val finiteNumber = Column("FiniteNumber", "real") { v ->
            when (v) {
                is JsonValue.IntVal -> null
                is JsonValue.DoubleVal -> if (v.value.isFinite()) null else "Expected a finite number."
                else -> "Expected a finite number."
            }
        }
        val sqliteBoolean = Column("SqliteBoolean", "integer") { v ->
            when (v) {
                is JsonValue.Bool -> null
                is JsonValue.IntVal -> if (v.value == 0L || v.value == 1L) null else "Expected a SQLite boolean (0 or 1)."
                else -> "Expected a SQLite boolean (0 or 1)."
            }
        }
        val simpleName = Column("SimpleName", "text") { v ->
            val s = (v as? JsonValue.Str)?.value ?: return@Column "Expected a string."
            val ok = s.isNotEmpty() && s.length <= 64 && s.all { it.code < 128 && (it.isLetterOrDigit() || it == '-') }
            if (ok) null else "Expected a simple name ([A-Za-z0-9-], 1–64 chars)."
        }
        val mnemonic = Column("Mnemonic", "text") { v ->
            val s = (v as? JsonValue.Str)?.value
            if (s != null && Bip39.isValid(s)) null else "Expected a valid BIP39 recovery phrase."
        }

        /** An id column for a table, e.g. `id("category")`. */
        fun id(table: String): Column = Column("${table}Id", "text") { v ->
            val s = (v as? JsonValue.Str)?.value
            if (s != null && s.isNotEmpty()) null else "Expected an id string."
        }

        /** Wraps a column so it also accepts `null` (the `nullOr` analog). */
        fun nullable(base: Column): Column =
            Column("${base.name}OrNull", base.sqlite, nullable = true, validate = base.validate)

        /** Wraps a string column with a maximum length (the `maxLength` analog). */
        fun maxLength(max: Int, base: Column): Column =
            Column("${base.name}Max$max", base.sqlite, base.nullable) { v ->
                base.validate(v)?.let { return@Column it }
                val s = (v as? JsonValue.Str)?.value
                if (s != null && s.length > max) "Expected at most $max characters." else null
            }
    }
}

/**
 * A schema: `{ table -> { column -> Column } }`. The engine derives one physical
 * SQLite table per entry, adding the system columns (`createdAt`, `updatedAt`,
 * `isDeleted`) to every table automatically.
 */
class Schema(val tables: Map<String, Map<String, Column>>) {
    val tableNames: List<String> get() = tables.keys.sorted()
    fun columns(table: String): Map<String, Column>? = tables[table]
    fun has(table: String): Boolean = tables.containsKey(table)
}

/** SQLite boolean constants, mirroring `sqliteTrue` / `sqliteFalse`. */
val sqliteTrue: JsonValue = JsonValue.IntVal(1)
val sqliteFalse: JsonValue = JsonValue.IntVal(0)

/** How a `JsonValue` binds into SQLite. */
fun JsonValue.toSqlite(): SqliteValue = when (this) {
    is JsonValue.Str -> SqliteValue.Text(value)
    is JsonValue.IntVal -> SqliteValue.Integer(value)
    is JsonValue.DoubleVal -> SqliteValue.Real(value)
    is JsonValue.Bool -> SqliteValue.Integer(if (value) 1 else 0)
    JsonValue.Null -> SqliteValue.Null
    is JsonValue.Arr, is JsonValue.Obj -> SqliteValue.Text(canonical())
}

/** Convert a SQLite cell back into a JsonValue (for re-merging existing rows). */
fun SqliteValue.toJson(): JsonValue = when (this) {
    is SqliteValue.Text -> JsonValue.Str(value)
    is SqliteValue.Integer -> JsonValue.IntVal(value)
    is SqliteValue.Real -> JsonValue.DoubleVal(value)
    is SqliteValue.Blob -> JsonValue.Null
    SqliteValue.Null -> JsonValue.Null
}
