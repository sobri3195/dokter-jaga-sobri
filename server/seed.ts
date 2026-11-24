import { pool, transaction, logDatabaseError } from './db'
import { currentEngineVersion } from './engine'
import { migrate } from './migrations'
import { scenario } from './scenario'

try {
  await transaction(async client => {
    await migrate(client)
    const { id, version } = scenario.info
    await client.query('INSERT INTO cases (id) VALUES ($1) ON CONFLICT DO NOTHING', [id])
    await client.query(`INSERT INTO case_versions (case_id,version,definition,engine_version)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [id, version, scenario, currentEngineVersion])
    const { rows } = await client.query(`SELECT definition = $3::jsonb AND engine_version = $4 AS matches
      FROM case_versions WHERE case_id=$1 AND version=$2`, [id, version, scenario, currentEngineVersion])
    if (!rows[0].matches) throw new Error('Versi skenario sudah ada dengan isi berbeda. Gunakan versi baru.')
  })
  console.log('Migrasi dan seed selesai.')
} catch (error) {
  logDatabaseError('db.setup', error)
  if (error instanceof Error && (error.message.startsWith('Applied migration ') || error.message.startsWith('Versi skenario '))) {
    console.error(error.message)
  }
  process.exitCode = 1
} finally {
  if (process.env.DATABASE_URL) await pool().end()
}
