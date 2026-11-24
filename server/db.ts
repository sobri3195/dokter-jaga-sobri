import pg from 'pg'
import type { PoolClient } from 'pg'

let instance: pg.Pool | undefined

export function pool() {
  if (!instance) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing')
    instance = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 })
    instance.on('error', error => console.error('Idle database connection error', error.name))
  }
  return instance
}

export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect()
  let discard = false
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { discard = true }
    throw error
  } finally {
    client.release(discard)
  }
}
