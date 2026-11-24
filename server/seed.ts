import { readdir, readFile } from 'node:fs/promises'
import { pool, transaction } from './db'
import { scenario } from './scenario'

try {
  await transaction(async client => {
    const directory = new URL('../db/', import.meta.url)
    const migrations = (await readdir(directory)).filter(name => /^\d+_.*\.sql$/.test(name)).sort()
    for (const name of migrations) {
      await client.query(await readFile(new URL(name, directory), 'utf8'))
    }
    const { id, version } = scenario.info
    await client.query('INSERT INTO cases (id) VALUES ($1) ON CONFLICT DO NOTHING', [id])
    await client.query('INSERT INTO case_versions VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, version, scenario])
    const { rows } = await client.query('SELECT definition = $3::jsonb AS matches FROM case_versions WHERE case_id=$1 AND version=$2', [id, version, scenario])
    if (!rows[0].matches) throw new Error('Versi skenario sudah ada dengan isi berbeda. Gunakan versi baru.')
  })
  console.log('Migrasi dan seed selesai.')
} finally {
  await pool().end()
}
