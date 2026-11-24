import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { logDatabaseError, transaction } from './db'
import { engineFor } from './engine'
import type { State } from './engine'
import type { Scenario } from './scenario'

const uuid = z.uuid()
const bootstrap = z.strictObject({})
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

function guestCookie(req: IncomingMessage) {
  const cookie = req.headers.cookie?.match(/(?:^|;\s*)jaga_guest=([^;]+)/)?.[1]
  return cookie && uuid.safeParse(cookie).success ? cookie : undefined
}

function owner(req: IncomingMessage) {
  const id = guestCookie(req)
  if (!id) fail(404, 'Sesi tidak ditemukan.')
  return id
}

function touchGuest(client: PoolClient, id: string) {
  return client.query(`UPDATE guests SET last_seen_at=now()
    WHERE id=$1 AND last_seen_at < now() - interval '1 day'`, [id])
}

async function bootstrapGuest(req: IncomingMessage, res: ServerResponse) {
  const cookie = guestCookie(req)
  const result = await transaction(async client => {
    if (cookie) {
      if ((await touchGuest(client, cookie)).rowCount) return cookie
      if ((await client.query('SELECT 1 FROM guests WHERE id=$1', [cookie])).rowCount) return cookie
    }
    // Use only the Vercel-managed source header on Vercel. Standalone deployments use the TCP peer.
    const forwarded = process.env.VERCEL === '1' ? req.headers['x-vercel-forwarded-for'] : undefined
    const source = typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress ?? 'unknown'
    const sourceHash = createHash('sha256').update(source).digest('hex')
    const { rows } = await client.query(`INSERT INTO guest_admissions VALUES (floor(extract(epoch from now()) / 60), $1, 1)
      ON CONFLICT (bucket, source_hash) DO UPDATE SET count = guest_admissions.count + 1
      WHERE guest_admissions.count < 30 RETURNING count`, [sourceHash])
    if (!rows.length) return undefined
    const id = randomUUID()
    await client.query('INSERT INTO guests (id) VALUES ($1)', [id])
    return id
  })
  if (!result) {
    res.setHeader('Retry-After', '60')
    fail(429, 'Terlalu banyak identitas tamu baru. Coba lagi dalam satu menit.')
  }
  const https = process.env.VERCEL === '1' || process.env.APP_ORIGIN?.startsWith('https://') || req.headers['x-forwarded-proto'] === 'https'
  // Refresh the same credential only through the bootstrap route, which the browser serializes.
  res.setHeader('Set-Cookie', `jaga_guest=${result}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000${https ? '; Secure' : ''}`)
}

async function permit(client: PoolClient, id: string, kind: 'create' | 'action') {
  const { rows } = await client.query(`
    INSERT INTO rate_limits VALUES ($1, floor(extract(epoch from now()) / 60), $2, 1)
    ON CONFLICT (guest_id, kind, bucket) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count
  `, [id, kind])
  return rows[0].count <= (kind === 'create' ? 12 : 120)
}

interface Stored { id: string; snapshot: State; revision: number; definition: Scenario; finished: boolean; engine_version: number }

const sessionQuery = `SELECT s.id,s.snapshot,s.revision,s.finished,v.definition,v.engine_version
 FROM sessions s JOIN case_versions v ON (v.case_id,v.version)=(s.case_id,s.version)
 WHERE s.id=$1 AND s.guest_id=$2`

async function create(input: z.infer<typeof creation>, owner: string) {
  return transaction(async client => {
    const guest = await client.query('SELECT id FROM guests WHERE id=$1 FOR NO KEY UPDATE', [owner])
    if (!guest.rowCount) return new HttpError(401, 'Siapkan identitas tamu sebelum memulai sesi.')
    if (input.creationId) {
      const { rows: existing } = await client.query<Stored>(`SELECT s.id,s.snapshot,s.revision,s.finished,v.definition,v.engine_version
        FROM sessions s JOIN case_versions v ON (v.case_id,v.version)=(s.case_id,s.version)
        WHERE s.guest_id=$1 AND s.creation_id=$2`, [owner, input.creationId])
      const replay = existing[0]
      if (replay) {
        const { id, version } = replay.definition.info
        if (id !== input.caseId || version !== input.version) {
          return new HttpError(409, 'ID pembuatan sesi sudah dipakai untuk kasus atau versi berbeda.')
        }
        return engineFor(replay.engine_version).snapshot(replay.definition, replay.snapshot, replay.id, replay.revision)
      }
    }
    if (!await permit(client, owner, 'create')) return new HttpError(429, 'Terlalu banyak sesi. Coba lagi dalam satu menit.')
    const { rows } = await client.query<{ definition: Scenario; engine_version: number }>('SELECT definition,engine_version FROM case_versions WHERE case_id=$1 AND version=$2', [input.caseId, input.version])
    if (!rows.length) return new HttpError(404, 'Versi kasus tidak ditemukan.')
    const { definition, engine_version } = rows[0]
    const { initial, snapshot } = engineFor(engine_version)
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
      return replay.response as ReturnType<ReturnType<typeof engineFor>['snapshot']>
    }
    if (!await permit(client, owner, 'action')) return new HttpError(429, 'Terlalu banyak aksi. Coba lagi dalam satu menit.')
    if (row.revision !== input.expectedRevision) return new HttpError(409, 'Sesi berubah di tab lain. Kondisi terbaru akan dimuat.')
    if (row.finished) return new HttpError(409, 'Sesi sudah selesai.')
    const { apply, debrief, snapshot } = engineFor(row.engine_version)
    const state = apply(row.definition, row.snapshot, input.actionId)
    if (!state) return new HttpError(422, 'Aksi ini tidak tersedia pada kondisi sekarang.')
    const revision = row.revision + 1
    const response = snapshot(row.definition, state, id, revision)
    await client.query('UPDATE sessions SET revision=$2,snapshot=$3,finished=$4,last_activity_at=now() WHERE id=$1', [id, revision, state, !!state.outcome])
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
  const requestId = randomUUID()
  res.setHeader('X-Request-Id', requestId)
  let operation = 'http.routing'
  try {
    const url = new URL(req.url ?? '/', 'http://internal.invalid')
    const path = url.pathname === '/api/dispatch' ? '/api/' + url.searchParams.get('route') : url.pathname
    const method = req.method
    if (method === 'POST') origin(req)
    if (method === 'GET' && path === '/api/cases') {
      operation = 'cases.list'
      const { rows } = await transaction(client => client.query(`SELECT DISTINCT ON (case_id) definition->'info' AS info
        FROM case_versions ORDER BY case_id, version DESC`))
      return send(res, 200, rows.map(row => row.info))
    }
    if (method === 'POST' && path === '/api/guests') {
      operation = 'guests.bootstrap'
      await body(req, bootstrap)
      await bootstrapGuest(req, res)
      return send(res, 200, {})
    }
    if (path === '/api/sessions') {
      if (method === 'GET') {
        operation = 'sessions.list'
        const owner = guestCookie(req)
        if (!owner) return send(res, 200, [])
        const { rows } = await transaction(async client => {
          await touchGuest(client, owner)
          return client.query(`SELECT s.id,v.definition->'info'->>'title' AS title,
            CASE WHEN s.finished THEN 'finished' ELSE 'active' END AS status, s.created
            FROM sessions s JOIN case_versions v ON (v.case_id,v.version)=(s.case_id,s.version)
            WHERE guest_id=$1 ORDER BY created DESC, s.id DESC`, [owner])
        })
        return send(res, 200, rows)
      }
      if (method === 'POST') {
        operation = 'sessions.create'
        const input = await body(req, creation)
        const owner = guestCookie(req)
        if (!owner) fail(401, 'Siapkan identitas tamu sebelum memulai sesi.')
        const result = await create(input, owner)
        if (result instanceof HttpError) throw result
        return send(res, 201, result)
      }
    }
    const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(actions|debrief))?$/)
    if (!match || !uuid.safeParse(match[1]).success) fail(404, 'Rute tidak ditemukan.')
    const [, id, resource] = match
    if (method === 'GET' && !resource) {
      operation = 'sessions.get'
      const guestId = owner(req)
      const { rows } = await transaction(client => client.query<Stored>(sessionQuery, [id, guestId]))
      if (!rows.length) fail(404, 'Sesi tidak ditemukan.')
      const row = rows[0]
      return send(res, 200, engineFor(row.engine_version).snapshot(row.definition, row.snapshot, id, row.revision))
    }
    if (method === 'GET' && resource === 'debrief') {
      operation = 'sessions.debrief'
      const guestId = owner(req)
      const { rows } = await transaction(client => client.query(`SELECT d.result FROM session_debriefs d JOIN sessions s ON s.id=d.session_id
        WHERE s.id=$1 AND s.guest_id=$2`, [id, guestId]))
      if (!rows.length) fail(404, 'Debrief belum tersedia.')
      return send(res, 200, rows[0].result)
    }
    if (method === 'POST' && resource === 'actions') {
      operation = 'sessions.action'
      const result = await act(req, owner(req), id)
      if (result instanceof HttpError) throw result
      return send(res, 200, result)
    }
    fail(405, 'Metode tidak didukung.')
  } catch (error) {
    if (error instanceof HttpError) return send(res, error.status, { error: error.message })
    logDatabaseError(operation, error, requestId)
    return send(res, 500, { error: 'Terjadi galat server. Coba lagi.', requestId })
  }
}
