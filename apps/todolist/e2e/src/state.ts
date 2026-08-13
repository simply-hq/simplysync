// State comparison for the sync harness. Runners dump raw rows per synced table
// (`exportState`); here we canonicalize and diff them.
//
// The TodoList clients intentionally share one schema. Cross-platform
// comparisons still intersect columns so a future platform-local column does
// not accidentally become part of the wire contract.

export type Row = Record<string, unknown>;
type TableState = Row[];
export type DeviceState = Record<string, TableState>;

export interface Diff {
  table: string;
  rowId: string | null;
  detail: string;
}

function indexById(rows: TableState): Map<string, Row> {
  const map = new Map<string, Row>();
  for (const row of rows) map.set(String(row.id), row);
  return map;
}

/** Deep-ish value equality for scalar cell values (SQLite gives number/string/null). */
function cellEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  // JSON numbers vs strings are kept distinct — a mismatch there is a real bug.
  return a === b;
}

export function diffStates(
  labelA: string,
  a: DeviceState,
  labelB: string,
  b: DeviceState,
  opts: { crossPlatform: boolean },
): Diff[] {
  const diffs: Diff[] = [];
  const tables = new Set([...Object.keys(a), ...Object.keys(b)]);

  for (const table of [...tables].sort()) {
    const ra = indexById(a[table] ?? []);
    const rb = indexById(b[table] ?? []);
    const ids = new Set([...ra.keys(), ...rb.keys()]);

    for (const id of [...ids].sort()) {
      const rowA = ra.get(id);
      const rowB = rb.get(id);
      if (!rowA) {
        diffs.push({ table, rowId: id, detail: `present in ${labelB} only` });
        continue;
      }
      if (!rowB) {
        diffs.push({ table, rowId: id, detail: `present in ${labelA} only` });
        continue;
      }
      // Columns to compare: intersection for cross-platform (platform-local
      // columns are out of the sync contract), union otherwise.
      const cols = opts.crossPlatform
        ? [...Object.keys(rowA)].filter((c) => c in rowB)
        : [...new Set([...Object.keys(rowA), ...Object.keys(rowB)])];
      for (const col of cols.sort()) {
        if (!cellEqual(rowA[col], rowB[col])) {
          diffs.push({
            table,
            rowId: id,
            detail: `${col}: ${labelA}=${fmt(rowA[col])} vs ${labelB}=${fmt(rowB[col])}`,
          });
        }
      }
    }
  }
  return diffs;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v.length > 60 ? JSON.stringify(v.slice(0, 57) + "…") : JSON.stringify(v);
  return String(v);
}

export function formatDiffs(diffs: Diff[]): string {
  return diffs
    .map((d) => `  - ${d.table}${d.rowId ? `#${d.rowId}` : ""}: ${d.detail}`)
    .join("\n");
}

/** Find one row by id within a device's dumped state. */
export function findRow(state: DeviceState, table: string, rowId: string): Row | undefined {
  return (state[table] ?? []).find((r) => String(r.id) === rowId);
}
