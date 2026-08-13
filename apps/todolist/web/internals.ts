export type RawRow = Record<string, unknown>;
export type SelectRows = (sql: string) => RawRow[];

export function readOutboxDiagnostics(select: SelectRows): {
  recent: RawRow[];
  pending: number;
  total: number;
} {
  const recent = select(
    `select event_id, envelope_json, pushed_at from "_sync_outbox" order by event_id desc limit 8`,
  );
  const pending =
    (select(
      `select count(*) as c from "_sync_outbox" where pushed_at is null`,
    )[0]?.c as number | undefined) ?? 0;
  const total =
    (select(`select count(*) as c from "_sync_outbox"`)[0]?.c as
      | number
      | undefined) ?? 0;

  return { recent, pending, total };
}
