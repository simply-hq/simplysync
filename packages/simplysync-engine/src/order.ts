// Fractional indexing: conflict-light ordering keys for reorderable lists.
//
// Many personal apps need a stable, user-controllable order that survives
// offline edits and merges cleanly — todo lists you drag to reorder, chat
// messages and threaded replies inserted between siblings, kanban cards, photo
// albums. A plain numeric `order` column under last-writer-wins forces a
// renumber of every following row on each move (so two offline devices that
// both reorder clobber each other), and integer gaps run out.
//
// Instead, give each row a string key drawn from an ordering alphabet and keep
// rows sorted by that key. To move a row, mint a NEW key strictly between its
// two new neighbours with `keyBetween` — only that one row's `order` column
// changes, so it merges under LWW like any other single-field edit and never
// disturbs its neighbours. Because there is always a key between any two
// distinct keys, you never run out of room.
//
// Keys are compared as plain strings, so `order by order` in SQL (or
// `Array.prototype.sort()`) yields the intended sequence with no special
// collation. Concurrent inserts at the same slot can mint equal keys; break
// such ties with a stable secondary sort on `id` (see `compareOrderKeys`).

// Base-62 digits in ascending code-unit order ('0'<'9'<'A'<'Z'<'a'<'z'), so
// lexicographic string comparison agrees with digit value — the property the
// whole scheme rests on. Treat a key as the fractional part of a base-62 number
// in [0, 1): "V" ≈ 0.V, "" ≈ 0, and a null upper bound ≈ 1.
export const ORDER_KEY_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const BASE = ORDER_KEY_ALPHABET.length;
const MIN_DIGIT = ORDER_KEY_ALPHABET[0]; // "0"

// Digit -> value lookup. indexOf would be O(n) per digit; this is O(1).
const DIGIT_VALUE: Record<string, number> = {};
for (let i = 0; i < ORDER_KEY_ALPHABET.length; i++) {
  DIGIT_VALUE[ORDER_KEY_ALPHABET[i] as string] = i;
}

/** True when `value` is a syntactically valid ordering key (1+ alphabet chars). */
export const isOrderKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  [...value].every((ch) => ch in DIGIT_VALUE);

// Trailing minimum digits don't change a fraction's value ("V0" == "V"), but
// they do change string comparison and can hide that two keys are numerically
// equal. Canonicalize to the shortest form before reasoning about order.
const trimTrailingMin = (key: string): string => {
  let end = key.length;
  while (end > 0 && key[end - 1] === MIN_DIGIT) end--;
  return key.slice(0, end);
};

const digitAt = (key: string, i: number): number =>
  i < key.length ? (DIGIT_VALUE[key[i] as string] as number) : 0;

/**
 * Return a key `m` such that `lower < m < upper` as strings, where each bound is
 * the fractional part of a base-62 number. `lower` is `""` (≈ 0); `upper` null
 * means the open upper bound (≈ 1). Assumes `lower < upper` numerically.
 */
const midpoint = (lower: string, upper: string | null): string => {
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const lo = digitAt(lower, i);
    // Beyond `upper`'s digits the upper bound's fractional digits are 0; a null
    // upper bound is the open value 1, i.e. one past the largest digit (BASE).
    const hi = upper === null ? BASE : digitAt(upper, i);
    if (lo === hi) {
      // No room to split at this position yet — copy the shared digit and
      // descend. (`hi` can equal `lo` only when upper !== null.)
      out.push(ORDER_KEY_ALPHABET[lo] as string);
      continue;
    }
    const mid = Math.floor((lo + hi) / 2);
    if (mid > lo) {
      out.push(ORDER_KEY_ALPHABET[mid] as string);
      return out.join("");
    }
    // hi === lo + 1: the gap is too small for a digit here. Keep `lower`'s digit
    // and recurse into the next position, where any digit keeps us below
    // `upper` — so the upper bound becomes open (1).
    out.push(ORDER_KEY_ALPHABET[lo] as string);
    upper = null;
  }
};

/**
 * Mint an ordering key strictly between `a` and `b`.
 *
 * - `keyBetween(null, null)` → a first key for an empty list.
 * - `keyBetween(null, first)` → a key that sorts before `first` (prepend).
 * - `keyBetween(last, null)` → a key that sorts after `last` (append).
 * - `keyBetween(a, b)` → a key strictly between two existing neighbours.
 *
 * The result always satisfies `a < result < b` under plain string comparison.
 * Throws if `a >= b`, so callers pass neighbours in order.
 */
export const keyBetween = (
  a: string | null | undefined,
  b: string | null | undefined,
): string => {
  const lower = a == null ? "" : trimTrailingMin(a);
  const upper = b == null ? null : trimTrailingMin(b);
  if (a != null && !isOrderKey(a))
    throw new Error(`Invalid lower ordering key: ${JSON.stringify(a)}`);
  if (b != null && !isOrderKey(b))
    throw new Error(`Invalid upper ordering key: ${JSON.stringify(b)}`);
  if (upper !== null && lower >= upper)
    throw new Error(
      `Ordering keys out of order: ${JSON.stringify(a)} >= ${JSON.stringify(b)}`,
    );
  return midpoint(lower, upper);
};

/**
 * Mint `n` keys evenly spread strictly between `a` and `b`, in ascending order.
 * Useful for seeding an initial ordered list, or re-spreading after a batch
 * insert. Returns `[]` for `n <= 0`.
 */
export const keysBetween = (
  a: string | null | undefined,
  b: string | null | undefined,
  n: number,
): string[] => {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  // Bisect: place the middle key, then recurse into each half. This keeps the
  // keys short (depth ~log2(n)) rather than chaining n appends off one end.
  const mid = keyBetween(a, b);
  const left = Math.floor(n / 2);
  return [
    ...keysBetween(a, mid, left),
    mid,
    ...keysBetween(mid, b, n - left - 1),
  ];
};

/**
 * Total order for ordering keys, tie-broken by `id` so concurrently-minted
 * equal keys still sort deterministically across devices. Use as the comparator
 * when sorting rows in memory, and mirror it in SQL with
 * `order by "order", id`.
 */
export const compareOrderKeys = (
  a: { order: string; id: string },
  b: { order: string; id: string },
): number =>
  a.order < b.order
    ? -1
    : a.order > b.order
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;
