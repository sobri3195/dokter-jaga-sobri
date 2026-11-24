import pg from 'pg'
import type { PoolClient } from 'pg'

export function logDatabaseError(operation: string, error: unknown, requestId?: string) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[A-Z0-9_]{2,32}$/.test(error.code) ? error.code : undefined
  console.error(JSON.stringify({ operation, requestId, code, type: error instanceof Error ? error.name : 'unknown' }))
}

let instance: pg.Pool | undefined

export function pool() {
  if (!instance) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing')
    instance = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 })
    instance.on('error', error => logDatabaseError('db.idle', error))
  }
  return instance
}

export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect()
  let discard = false
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout = '8s'; SET LOCAL lock_timeout = '3s'; SET LOCAL idle_in_transaction_session_timeout = '15s'")
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
