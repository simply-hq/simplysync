import Foundation

// Fractional indexing: conflict-light ordering keys for reorderable lists — the
// Swift port of the engine's `order.ts` / `Order.kt`. Give each row a string key
// and keep rows sorted by it; to move a row, mint a NEW key strictly between its
// two new neighbours with `keyBetween`. Only that one row's key changes, so the
// move merges under LWW like any single-field edit. Keys compare as plain
// strings, so `order by "order"` yields the intended sequence; break ties between
// equal keys with `compareOrderKeys`.

/// Base-62 digits in ascending code-unit order, so lexicographic comparison
/// agrees with digit value — the property the scheme rests on.
let orderKeyAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

private let orderBase = 62
private let orderMinDigit: Character = "0"
private let orderAlphabetChars = Array(orderKeyAlphabet)
private let orderDigitValue: [Character: Int] = {
    var m = [Character: Int]()
    for (i, c) in orderKeyAlphabet.enumerated() { m[c] = i }
    return m
}()

enum OrderKeyError: Error { case invalid(String) }

/// True when `value` is a syntactically valid ordering key (1+ alphabet chars).
func isOrderKey(_ value: String) -> Bool {
    !value.isEmpty && value.allSatisfy { orderDigitValue[$0] != nil }
}

// Trailing minimum digits don't change a key's value ("V0" == "V") but do change
// string comparison; canonicalize before reasoning about order.
private func trimTrailingMin(_ key: String) -> String {
    var chars = Array(key)
    while let last = chars.last, last == orderMinDigit { chars.removeLast() }
    return String(chars)
}

private func orderDigitAt(_ key: [Character], _ i: Int) -> Int {
    i < key.count ? (orderDigitValue[key[i]] ?? 0) : 0
}

private func orderMidpoint(_ lower: String, _ upperIn: String?) -> String {
    let lowerChars = Array(lower)
    let upperChars = upperIn.map { Array($0) }
    var open = upperIn == nil
    var out = ""
    var i = 0
    while true {
        let lo = orderDigitAt(lowerChars, i)
        // Beyond `upper`'s digits its fractional digits are 0; a null upper bound is
        // the open value 1, i.e. one past the largest digit (orderBase).
        let hi = open ? orderBase : orderDigitAt(upperChars!, i)
        if lo == hi {
            out.append(orderAlphabetChars[lo]) // copy shared digit and descend
            i += 1
            continue
        }
        let mid = (lo + hi) / 2
        if mid > lo {
            out.append(orderAlphabetChars[mid])
            return out
        }
        // hi == lo + 1: no room here. Keep lower's digit; below it any digit stays
        // under `upper`, so the upper bound becomes open.
        out.append(orderAlphabetChars[lo])
        open = true
        i += 1
    }
}

/// Mint an ordering key strictly between `a` and `b` (nil = unbounded). Always
/// satisfies `a < result < b` as strings. Throws if `a >= b` or a bound is malformed.
func keyBetween(_ a: String?, _ b: String?) throws -> String {
    if let a, !isOrderKey(a) { throw OrderKeyError.invalid("Invalid lower ordering key: \(a)") }
    if let b, !isOrderKey(b) { throw OrderKeyError.invalid("Invalid upper ordering key: \(b)") }
    let lower = a.map(trimTrailingMin) ?? ""
    let upper = b.map(trimTrailingMin)
    if let upper, lower >= upper {
        throw OrderKeyError.invalid("Ordering keys out of order: \(a ?? "nil") >= \(b ?? "nil")")
    }
    return orderMidpoint(lower, upper)
}

/// Mint `n` keys evenly spread strictly between `a` and `b`, ascending.
func keysBetween(_ a: String?, _ b: String?, _ n: Int) throws -> [String] {
    if n <= 0 { return [] }
    if n == 1 { return [try keyBetween(a, b)] }
    let mid = try keyBetween(a, b)
    let left = n / 2
    return try keysBetween(a, mid, left) + [mid] + keysBetween(mid, b, n - left - 1)
}

/// Total order for rows by ordering key, tie-broken by id so concurrently-minted
/// equal keys still sort deterministically. Mirror in SQL with `order by "order", id`.
func compareOrderKeys(_ aOrder: String, _ aId: String, _ bOrder: String, _ bId: String) -> Int {
    if aOrder != bOrder { return aOrder < bOrder ? -1 : 1 }
    if aId != bId { return aId < bId ? -1 : 1 }
    return 0
}
