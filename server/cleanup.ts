import { logDatabaseError, pool, transaction } from './db'
import { retain } from './retention'

const flags = process.argv.slice(2)
if (flags.some(flag => flag !== '--apply')) throw new Error('Gunakan db:cleanup [--apply].')
const apply = flags.includes('--apply')

try {
  const report = await transaction(client => retain(client, apply))
  console.log(JSON.stringify({ mode: apply ? 'deleted' : 'dry-run', ...report }))
} catch (error) {
  logDatabaseError('db.cleanup', error)
  process.exitCode = 1
} finally {
  if (process.env.DATABASE_URL) await pool().end()
}
