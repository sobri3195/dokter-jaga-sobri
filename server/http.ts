import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { pool, transaction } from './db'
import { apply, debrief, initial, snapshot } from './engine'
import type { State } from './engine'
import type { Scenario } from './scenario'

const uuid = z.uuid()
const creation = z.strictObject({ caseId: z.string().min(1).max(80), version: z.int().positive().max(2147483647), creationId: uuid.optional() })
const command = z.strictObject({
  actionId: z.string().min(1).max(40), commandId: uuid, expectedRevision: z.int().nonnegative().max(2147483647),
  parameters: z.strictObject({}).optional(),
})

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function fail(status: number, message: string): never { throw new HttpError(status, message) }

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function body<T>(req: IncomingMessage, schema: z.ZodType<T>) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'Gunakan format JSON.')
  const parsed = (req as IncomingMessage & { body?: unknown }).body
  let input: unknown = parsed
  if (parsed === undefined || typeof parsed === 'string' || Buffer.isBuffer(parsed)) {
    let raw = parsed === undefined ? '' : parsed.toString()
    if (parsed === undefined) {
      for await (const chunk of req) {
        raw += chunk
        if (Buffer.byteLength(raw) > 4096) fail(413, 'Permintaan terlalu besar.')
      }
    }
    try { input = JSON.parse(raw) } catch { fail(400, 'JSON tidak valid.') }
  }
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 4096) fail(413, 'Permintaan terlalu besar.')
  const result = schema.safeParse(input)
  if (!result.success) fail(400, 'Data permintaan tidak valid.')
  return result.data
}

function origin(req: IncomingMessage) {
  const isVercel = process.env.VERCEL === '1'
  const host = req.headers.host ?? ''
  const vercelOrigin = isVercel && /^[a-z0-9.-]+$/i.test(host) ? `https://${host}` : undefined
  const allowed = process.env.APP_ORIGIN ?? (isVercel ? vercelOrigin : 'http://localhost:5173')
  if (!allowed || req.headers.origin !== allowed) fail(403, 'Asal permintaan tidak diizinkan.')
}

async function guest(req: IncomingMessage, res: ServerResponse) {
  const cookie = req.headers.cookie?.match(/(?:^|;\s*)jaga_guest=([^;]+)/)?.[1]
  if (uuid.safeParse(cookie).success && (await pool().query('SELECT 1 FROM guests WHERE id=$1', [cookie])).rowCount) return cookie!
  const id = randomUUID()
  await pool().query('INSERT INTO guests VALUES ($1)', [id])
  const https = process.env.VERCEL === '1' || process.env.APP_ORIGIN?.startsWith('https://') || req.headers['x-forwarded-proto'] === 'https'
  res.setHeader('Set-Cookie', `jaga_guest=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${https ? '; Secure' : ''}`)
  return id
}

async function permit(client: PoolClient, id: string, kind: 'create' | 'action') {
  const { rows } = await client.query(`
    INSERT INTO rate_limits VALUES ($1, floor(extract(epoch from now()) / 60), $2, 1)
    ON CONFLICT (guest_id, kind, bucket) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count
  `, [id, kind])
  return rows[0].count <= (kind === 'create' ? 12 : 120)
}

interface Stored { id: string; snapshot: State; revision: number; definition: Scenario; finished: boolean }

const sessionQuery = `SELECT s.id,s.snapshot,s.revision,s.finished,v.definition
 FROM sessions s JOIN case_versions v ON (v.case_id,v.version)=(s.case_id,s.version)
 WHERE s.id=$1 AND s.guest_id=$2`

async function create(req: IncomingMessage, owner: string) {
  const input = await body(req, creation)
  return transaction(async client => {
    if (input.creationId) {
      await client.query('SELECT id FROM guests WHERE id=$1 FOR NO KEY UPDATE', [owner])
      const { rows: existing } = await client.query<Stored>(`SELECT s.id,s.snapshot,s.revision,s.finished,v.definition
        FROM sessions s JOIN case_versions v ON (v.case_id,v.version)=(s.case_id,s.version)
        WHERE s.guest_id=$1 AND s.creation_id=$2`, [owner, input.creationId])
      const replay = existing[0]
      if (replay) {
        const { id, version } = replay.definition.info
        if (id !== input.caseId || version !== input.version) {
          return new HttpError(409, 'ID pembuatan sesi sudah dipakai untuk kasus atau versi berbeda.')
        }
        return snapshot(replay.definition, replay.snapshot, replay.id, replay.revision)
      }
    }
    if (!await permit(client, owner, 'create')) return new HttpError(429, 'Terlalu banyak sesi. Coba lagi dalam satu menit.')
    const { rows } = await client.query<{ definition: Scenario }>('SELECT definition FROM case_versions WHERE case_id=$1 AND version=$2', [input.caseId, input.version])
    if (!rows.length) return new HttpError(404, 'Versi kasus tidak ditemukan.')
    const { definition } = rows[0]
    const id = randomUUID()
    const state = initial(definition)
    await client.query('INSERT INTO sessions (id,guest_id,case_id,version,snapshot,creation_id) VALUES ($1,$2,$3,$4,$5,$6)', [id, owner, input.caseId, input.version, state, input.creationId ?? null])
    await saveEvents(client, id, state, 0)
    return snapshot(definition, state, id, 0)
  })
}

async function saveEvents(client: PoolClient, id: string, state: State, from: number) {
  for (let index = from; index < state.events.length; index++) {
    await client.query('INSERT INTO session_events VALUES ($1,$2,$3)', [id, index, state.events[index]])
  }
}

async function act(req: IncomingMessage, owner: string, id: string) {
  const input = await body(req, command)
  const fingerprint = createHash('sha256').update(JSON.stringify([input.actionId, input.expectedRevision, input.parameters ?? {}])).digest('hex')
  return transaction(async client => {
    const { rows } = await client.query<Stored>(sessionQuery + ' FOR UPDATE OF s', [id, owner])
    const row = rows[0]
    if (!row) return new HttpError(404, 'Sesi tidak ditemukan.')
    const replay = (await client.query('SELECT fingerprint,response FROM session_commands WHERE session_id=$1 AND command_id=$2', [id, input.commandId])).rows[0]
    if (replay) {
      if (replay.fingerprint !== fingerprint) return new HttpError(409, 'ID perintah sudah dipakai untuk data berbeda.')
      return replay.response as ReturnType<typeof snapshot>
    }
    if (!await permit(client, owner, 'action')) return new HttpError(429, 'Terlalu banyak aksi. Coba lagi dalam satu menit.')
    if (row.revision !== input.expectedRevision) return new HttpError(409, 'Sesi berubah di tab lain. Kondisi terbaru akan dimuat.')
    if (row.finished) return new HttpError(409, 'Sesi sudah selesai.')
    const state = apply(row.definition, row.snapshot, input.actionId)
    if (!state) return new HttpError(422, 'Aksi ini tidak tersedia pada kondisi sekarang.')
    const revision = row.revision + 1
    const response = snapshot(row.definition, state, id, revision)
    await client.query('UPDATE sessions SET revision=$2,snapshot=$3,finished=$4 WHERE id=$1', [id, revision, state, !!state.outcome])
    await saveEvents(client, id, state, row.snapshot.events.length)
    await client.query('INSERT INTO session_commands VALUES ($1,$2,$3,$4)', [id, input.commandId, fingerprint, response])
    if (state.outcome) await client.query('INSERT INTO session_debriefs VALUES ($1,$2)', [id, debrief(row.definition, state)])
    return response
  })
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Vary', 'Cookie')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    const url = new URL(req.url ?? '/', 'http://internal.invalid')
    const path = url.pathname === '/api/dispatch' ? '/api/' + url.searchParams.get('route') : url.pathname
    const method = req.method
    if (method === 'POST') origin(req)
    if (method === 'GET' && path === '/api/cases') {
      const { rows } = await pool().query(`SELECT DISTINCT ON (case_id) definition->'info' AS info
        FROM case_versions ORDER BY case_id, version DESC`)
      return send(res, 200, rows.map(row => row.info))
    }
    if (path === '/api/sessions') {
      if (method === 'GET') {
        const owner = await guest(req, res)
        const { rows } = await pool().query(`SELECT s.id,v.definition->'info'->>'title' AS title,
          CASE WHEN s.finished THEN 'finished' ELSE 'active' END AS status, s.created
          FROM sessions s JOIN case_versions v ON (v.case_id,v.version)=(s.case_id,s.version)
          WHERE guest_id=$1 ORDER BY created DESC`, [owner])
        return send(res, 200, rows)
      }
      if (method === 'POST') {
        const result = await create(req, await guest(req, res))
        if (result instanceof HttpError) throw result
        return send(res, 201, result)
      }
    }
    const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(actions|debrief))?$/)
    if (!match || !uuid.safeParse(match[1]).success) fail(404, 'Rute tidak ditemukan.')
    const [, id, resource] = match
    if (method === 'GET' && !resource) {
      const { rows } = await pool().query<Stored>(sessionQuery, [id, await guest(req, res)])
      if (!rows.length) fail(404, 'Sesi tidak ditemukan.')
      const row = rows[0]
      return send(res, 200, snapshot(row.definition, row.snapshot, id, row.revision))
    }
    if (method === 'GET' && resource === 'debrief') {
      const { rows } = await pool().query(`SELECT d.result FROM session_debriefs d JOIN sessions s ON s.id=d.session_id
        WHERE s.id=$1 AND s.guest_id=$2`, [id, await guest(req, res)])
      if (!rows.length) fail(404, 'Debrief belum tersedia.')
      return send(res, 200, rows[0].result)
    }
    if (method === 'POST' && resource === 'actions') {
      const result = await act(req, await guest(req, res), id)
      if (result instanceof HttpError) throw result
      return send(res, 200, result)
    }
    fail(405, 'Metode tidak didukung.')
  } catch (error) {
    if (error instanceof HttpError) return send(res, error.status, { error: error.message })
    console.error('Database or request processing error', error instanceof Error ? error.name : 'unknown')
    return send(res, 500, { error: 'Terjadi galat server. Coba lagi.' })
  }
}
