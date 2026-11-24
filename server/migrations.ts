import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import type { PoolClient } from 'pg'

export async function migrate(client: PoolClient, directory = new URL('../db/', import.meta.url)) {
  await client.query("SET LOCAL statement_timeout = '60s'")
  await client.query('SELECT pg_advisory_xact_lock(813916205)')
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`)
  const files = (await readdir(directory)).filter(name => /^\d+_.*\.sql$/.test(name)).sort()
  const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')
  const applied = new Map(rows.map(row => [row.name, row.checksum]))
  for (const name of applied.keys()) {
    if (!files.includes(name)) throw new Error(`Applied migration missing: ${name}`)
  }
  for (const name of files) {
    const sql = await readFile(new URL(name, directory), 'utf8')
    const checksum = createHash('sha256').update(sql).digest('hex')
    if (applied.has(name)) {
      if (applied.get(name) !== checksum) throw new Error(`Applied migration changed: ${name}`)
      continue
    }
    await client.query(sql)
    await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)', [name, checksum])
  }
}
