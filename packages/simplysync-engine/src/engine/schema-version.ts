import type { SyncPayload } from "@simplysync/protocol";

export type RuntimeSyncPayload = SyncPayload<
  Record<string, unknown>,
  number
>;

export type ClassifiedSyncPayload =
  | { readonly kind: "supported"; readonly payload: RuntimeSyncPayload }
  | { readonly kind: "future"; readonly version: number }
  | { readonly kind: "invalid" };

/**
 * Treat payloads above this app's declared version as opaque. They must be
 * retained, not projected through a schema whose field meanings may be older.
 */
export function classifySyncPayload(
  value: unknown,
  supportedVersion: number,
): ClassifiedSyncPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid" };
  }
  const candidate = value as Record<string, unknown>;
  // Events written before schemaVersion became an enforced boundary are
  // interpreted as v1, preserving their historical behavior.
  const version = candidate.schemaVersion ?? 1;
  if (
    typeof version !== "number"
    || !Number.isSafeInteger(version)
    || version < 1
  ) {
    return { kind: "invalid" };
  }
  if (version > supportedVersion) {
    return { kind: "future", version };
  }
  if (
    typeof candidate.table !== "string"
    || candidate.table.length === 0
    || (candidate.op !== "upsert" && candidate.op !== "delete")
    || typeof candidate.rowId !== "string"
    || candidate.rowId.length === 0
    || typeof candidate.hlc !== "string"
    || typeof candidate.value !== "object"
    || candidate.value === null
    || Array.isArray(candidate.value)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "supported",
    payload: candidate as unknown as RuntimeSyncPayload,
  };
}
