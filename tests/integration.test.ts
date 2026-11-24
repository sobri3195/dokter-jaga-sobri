import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import handler from '../server/http'
import { pool, transaction } from '../server/db'
import { retain } from '../server/retention'
import { migrate } from '../server/migrations'
import { scenario } from '../server/scenario'

test.after(() => pool().end())

test('Postgres transactions and session API', async t => {
  assert.ok(process.env.DATABASE_URL, 'Use a dedicated test database and run db:setup first.')
  const server = createServer(handler).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const origin = process.env.APP_ORIGIN ?? 'http://localhost:5173'
  let cookie = ''
  async function req(path: string, body?: object, identity = cookie, source = origin) {
    const headers: Record<string, string> = { cookie: identity }
    if (body) Object.assign(headers, { origin: source, 'Content-Type': 'application/json' })
    const response = await fetch(base + '/api' + path, { headers, ...(body && { method: 'POST', body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json(), headers: response.headers }
  }
  const cases = await req('/cases')
  const version = scenario.info.version
  assert.equal(cases.data[0].id, scenario.info.id)
  assert.doesNotMatch(JSON.stringify(cases.data), /primaryCutoff|reassessments|outcomes/)
  const list = await req('/sessions')
  cookie = list.headers.get('set-cookie')!.split(';')[0]
  assert.match(list.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax/)
  assert.equal(list.headers.get('cache-control'), 'private, no-store')
  const input = { caseId: scenario.info.id, version }
  assert.equal((await req('/sessions', input, cookie, 'https://example.invalid')).status, 403)
  const creation = { ...input, creationId: randomUUID() }
  const [created, repeatedCreate] = await Promise.all([req('/sessions', creation), req('/sessions', creation)])
  assert.equal(created.status, 201)
  assert.equal(repeatedCreate.status, 201)
  assert.deepEqual(repeatedCreate.data, created.data)
  assert.equal((await req('/sessions')).data.length, 1)
  assert.equal((await req('/sessions', { ...creation, version: version + 1 })).status, 409)
  const anotherGuest = await req('/sessions', creation, '')
  assert.equal(anotherGuest.status, 201)
  assert.notEqual(anotherGuest.data.id, created.data.id)
  const path = '/sessions/' + created.data.id
  const anonymous = await req(path, undefined, '')
  assert.equal(anonymous.status, 404)
  assert.equal(anonymous.headers.get('set-cookie'), null)
  const deniedAction = await req(path + '/actions', {
    actionId: 'wait', commandId: randomUUID(), expectedRevision: 0,
  }, '')
  assert.equal(deniedAction.status, 404)
  assert.equal(deniedAction.headers.get('set-cookie'), null)
  assert.equal((await req(path + '/debrief')).status, 404)
  assert.doesNotMatch(JSON.stringify(created.data), /membuka mata|primaryCutoff|deadline|ratings/)
  const action = (actionId: string, expectedRevision: number) => ({ actionId, expectedRevision, commandId: randomUUID() })
  const send = (payload: ReturnType<typeof action>) => req(path + '/actions', payload)
  const primary = action('primary', 0)
  const [first, duplicate] = await Promise.all([send(primary), send(primary)])
  assert.equal(first.status, 200)
  assert.deepEqual(first.data, duplicate.data)
  assert.equal(first.data.tasks[0].id, 'primary')
  const [a, b] = await Promise.all([send(action('reassess', 1)), send(action('reassess', 1))])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  assert.equal((await req(path)).data.revision, 2)
  const resumedCreation = await req('/sessions', creation)
  assert.equal(resumedCreation.data.id, created.data.id)
  assert.equal(resumedCreation.data.revision, 2)
  assert.deepEqual((await send(primary)).data, first.data)
  assert.equal((await send({ ...primary, actionId: 'wait' })).status, 409)
  assert.equal((await req(path + '/actions', { ...action('wait', 2), parameters: { extra: true } })).status, 400)

  // Reject an event insert after the session UPDATE and verify that every write rolls back.
  const fault = 'reject_' + randomUUID().replaceAll('-', '')
  await pool().query(`ALTER TABLE session_events ADD CONSTRAINT ${fault}
    CHECK (session_id <> '${created.data.id}'::uuid OR seq < ${(await req(path)).data.timeline.length})`)
  const transport = action('transport', 2)
  try {
    const failure = await send(transport)
    assert.equal(failure.status, 500)
    assert.equal(failure.data.requestId, failure.headers.get('x-request-id'))
    assert.equal((await req(path)).data.revision, 2)
    assert.equal((await req(path)).data.transport, created.data.transport)
  } finally {
    await pool().query(`ALTER TABLE session_events DROP CONSTRAINT ${fault}`)
  }
  assert.equal((await send(transport)).data.revision, 3)

  const next = structuredClone(scenario)
  next.info.version = version + 1
  next.info.title = 'Versi pengujian'
  await pool().query(`INSERT INTO case_versions (case_id,version,definition)
    VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [next.info.id, next.info.version, next])
  await assert.rejects(pool().query('UPDATE case_versions SET engine_version=2 WHERE case_id=$1 AND version=$2', [next.info.id, version]), { code: '55000' })
  await assert.rejects(pool().query('DELETE FROM case_versions WHERE case_id=$1 AND version=$2', [next.info.id, next.info.version]), { code: '55000' })
  assert.equal((await req('/cases')).data[0].version, next.info.version)
  assert.equal((await req(path)).data.scenario.version, version)
  const commands = ['handover', 'reassess', 'handover', 'wait', 'wait', 'wait', 'wait', 'transfer']
  let revision = 3
  for (const id of commands) {
    const response = await send(action(id, revision))
    assert.equal(response.status, 200, JSON.stringify(response.data))
    revision = response.data.revision
  }
  const review = await req(path + '/debrief')
  assert.equal(review.data.outcome, scenario.outcomes.primary)
  assert.equal((await req(path + '/debrief', undefined, '')).status, 404)
  const repeated = await req('/sessions', input)
  assert.notEqual(repeated.data.id, created.data.id)
  assert.equal((await req('/sessions')).data.find((item: { id: string }) => item.id === created.data.id).status, 'finished')
})


test('alternate transfer and unresolved deadline through the API', async t => {
  const server = createServer(handler).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api'
  t.after(() => server.close())
  const origin = process.env.APP_ORIGIN ?? 'http://localhost:5173'
  const list = await fetch(base + '/sessions')
  const cookie = list.headers.get('set-cookie')!.split(';')[0]
  await list.json()
  const headers = { cookie, origin, 'Content-Type': 'application/json' }

  for (const [actions, outcome] of [
    [['transport', 'wait', 'wait', 'primary', 'reassess', 'alternate', 'wait', 'wait', 'handover', 'transfer'], scenario.outcomes.alternate],
    [Array<string>(12).fill('wait'), scenario.outcomes.deadline],
  ] as const) {
    const created = await fetch(base + '/sessions', { method: 'POST', headers, body: JSON.stringify({ caseId: scenario.info.id, version: scenario.info.version }) })
    assert.equal(created.status, 201)
    const session = await created.json()
    for (const [expectedRevision, actionId] of actions.entries()) {
      const response = await fetch(base + '/sessions/' + session.id + '/actions', {
        method: 'POST', headers, body: JSON.stringify({ expectedRevision, actionId, commandId: randomUUID() }),
      })
      const value = await response.json()
      assert.equal(response.status, 200, `${actionId}: ${JSON.stringify(value)}`)
    }
    const review = await fetch(base + '/sessions/' + session.id + '/debrief', { headers })
    assert.equal(review.status, 200)
    assert.equal((await review.json()).outcome, outcome)
  }
})


test('admission throttling, migration ledger, and bounded retention', async t => {
  const server = createServer(handler).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const { port } = server.address() as AddressInfo
  const source = createHash('sha256').update('127.0.0.1').digest('hex')
  const bucket = Math.floor(Date.now() / 60000)
  const previous = await pool().query('SELECT bucket,count FROM guest_admissions WHERE source_hash=$1 AND bucket BETWEEN $2 AND $3', [source, bucket, bucket + 1])
  await pool().query(`INSERT INTO guest_admissions SELECT generate_series($2::bigint,$3::bigint),$1,30
    ON CONFLICT (bucket, source_hash) DO UPDATE SET count=30`, [source, bucket, bucket + 1])
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`)
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), '60')
    assert.equal(response.headers.get('set-cookie'), null)
    await response.json()
  } finally {
    await pool().query('DELETE FROM guest_admissions WHERE source_hash=$1 AND bucket BETWEEN $2 AND $3', [source, bucket, bucket + 1])
    for (const row of previous.rows) await pool().query('INSERT INTO guest_admissions VALUES ($1,$2,$3)', [row.bucket, source, row.count])
  }

  await transaction(async client => {
    const before = await client.query('SELECT * FROM schema_migrations ORDER BY name')
    await migrate(client)
    assert.deepEqual((await client.query('SELECT * FROM schema_migrations ORDER BY name')).rows, before.rows)
    const { name, checksum } = before.rows[0]
    await client.query("UPDATE schema_migrations SET checksum='changed' WHERE name=$1", [name])
    await assert.rejects(migrate(client), /Applied migration changed/)
    await client.query('UPDATE schema_migrations SET checksum=$2 WHERE name=$1', [name, checksum])
    const { rows: [settings] } = await client.query(`SELECT current_setting('lock_timeout') AS lock,
      current_setting('idle_in_transaction_session_timeout') AS idle`)
    assert.deepEqual(settings, { lock: '3s', idle: '15s' })
    const owner = randomUUID()
    const id = randomUUID()
    await client.query("INSERT INTO guests (id,last_seen_at) VALUES ($1,now()-interval '91 days')", [owner])
    await client.query(`INSERT INTO sessions (id,guest_id,case_id,version,snapshot,last_activity_at)
      VALUES ($1,$2,$3,$4,'{}',now()-interval '91 days')`, [id, owner, scenario.info.id, scenario.info.version])
    await client.query("INSERT INTO session_events VALUES ($1,0,'{}')", [id])
    await client.query("INSERT INTO session_debriefs VALUES ($1,'{}')", [id])
    await client.query("INSERT INTO session_commands VALUES ($1,$2,'test','{}')", [id, randomUUID()])
    await client.query("INSERT INTO rate_limits VALUES ($1,0,'create',1)", [owner])
    await client.query("INSERT INTO guest_admissions VALUES (0,$1,1)", [owner])
    const dryRun = await retain(client, false)
    assert.ok(dryRun.sessions >= 1)
    assert.equal((await client.query('SELECT 1 FROM sessions WHERE id=$1', [id])).rowCount, 1)
    const applied = await retain(client, true)
    assert.ok(applied.sessions >= 1 && applied.guests >= 1 && applied.guest_admissions >= 1)
    for (const table of ['session_events', 'session_commands', 'session_debriefs']) {
      assert.equal((await client.query(`SELECT 1 FROM ${table} WHERE session_id=$1`, [id])).rowCount, 0)
    }
    assert.equal((await client.query('SELECT 1 FROM rate_limits WHERE guest_id=$1', [owner])).rowCount, 0)
  })
})
