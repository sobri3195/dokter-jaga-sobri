import { transaction } from './db'

const batchSize = 1000

const expiredSession = "last_activity_at < $1::timestamptz - interval '90 days'"
const expiredGuest = "last_seen_at < $1::timestamptz - interval '90 days'"
const expiredBucket = 'bucket < floor(extract(epoch from $1::timestamptz) / 60) - 1440'

const targets = [
  { table: 'sessions', key: 'id', expired: expiredSession, order: 'last_activity_at' },
  { table: 'rate_limits', key: 'guest_id,kind,bucket', expired: expiredBucket, order: 'bucket' },
  { table: 'guest_admissions', key: 'bucket,source_hash', expired: expiredBucket, order: 'bucket' },
  { table: 'guests', key: 'id', expired: `${expiredGuest} AND NOT EXISTS (SELECT 1 FROM sessions WHERE guest_id=guests.id)`, order: 'last_seen_at' },
] as const

type Report = Record<(typeof targets)[number]['table'], number>

export async function retain(apply: boolean, run = transaction) {
  // Use one cutoff for the whole run, including when each deletion batch commits separately.
  const cutoff = new Date()
  if (!apply) {
    return run(async client => {
      const { rows } = await client.query<Report>(`SELECT
        (SELECT count(*)::integer FROM sessions WHERE ${expiredSession}) AS sessions,
        (SELECT count(*)::integer FROM rate_limits WHERE ${expiredBucket}) AS rate_limits,
        (SELECT count(*)::integer FROM guest_admissions WHERE ${expiredBucket}) AS guest_admissions,
        (SELECT count(*)::integer FROM guests WHERE ${expiredGuest} AND NOT EXISTS (
          SELECT 1 FROM sessions WHERE guest_id=guests.id AND NOT (${expiredSession})
        )) AS guests`, [cutoff])
      return rows[0]
    })
  }

  const report: Report = { sessions: 0, rate_limits: 0, guest_admissions: 0, guests: 0 }
  for (const { table, key, expired, order } of targets) {
    let deleted: number
    do {
      deleted = await run(async client => {
        const result = await client.query(`DELETE FROM ${table}
          WHERE (${key}) IN (SELECT ${key} FROM ${table} WHERE ${expired}
            ORDER BY ${order}, ${key} LIMIT $2 FOR UPDATE)`, [cutoff, batchSize])
        return result.rowCount ?? 0
      })
      report[table] += deleted
    } while (deleted === batchSize)
  }
  return report
}
