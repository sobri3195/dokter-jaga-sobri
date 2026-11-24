import type { PoolClient } from 'pg'

const batchSize = 1000

const targets = [
  { table: 'sessions', key: 'id', expired: "last_activity_at < now() - interval '90 days'", order: 'last_activity_at' },
  { table: 'guests', key: 'id', expired: "last_seen_at < now() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM sessions WHERE guest_id=guests.id)", order: 'last_seen_at' },
  { table: 'rate_limits', key: 'guest_id,kind,bucket', expired: 'bucket < floor(extract(epoch from now()) / 60) - 1440', order: 'bucket' },
  { table: 'guest_admissions', key: 'bucket,source_hash', expired: 'bucket < floor(extract(epoch from now()) / 60) - 1440', order: 'bucket' },
] as const

export async function retain(client: PoolClient, apply: boolean) {
  const report: Record<string, number> = {}
  for (const { table, key, expired, order } of targets) {
    if (apply) {
      const { rowCount } = await client.query(`DELETE FROM ${table}
        WHERE (${key}) IN (SELECT ${key} FROM ${table} WHERE ${expired}
          ORDER BY ${order} LIMIT $1 FOR UPDATE SKIP LOCKED)`, [batchSize])
      report[table] = rowCount ?? 0
    } else {
      const { rows } = await client.query(`SELECT count(*)::integer AS total FROM (SELECT 1 FROM ${table}
        WHERE ${expired} LIMIT $1) AS candidates`, [batchSize])
      report[table] = rows[0].total
    }
  }
  return report
}
