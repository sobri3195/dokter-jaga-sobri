import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import handler from '../server/http'
import { pool } from '../server/db'
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
  const version = cases.data[0].version
  assert.equal(cases.data[0].id, scenario.info.id)
  assert.doesNotMatch(JSON.stringify(cases.data), /primaryCutoff|reassessments|outcomes/)
  const list = await req('/sessions')
  cookie = list.headers.get('set-cookie')!.split(';')[0]
  assert.match(list.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax/)
  assert.equal(list.headers.get('cache-control'), 'private, no-store')
  const input = { caseId: scenario.info.id, version }
  assert.equal((await req('/sessions', input, cookie, 'https://example.invalid')).status, 403)
  const created = await req('/sessions', input)
  assert.equal(created.status, 201)
  const path = '/sessions/' + created.data.id
  assert.equal((await req(path, undefined, '')).status, 404)
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
  assert.deepEqual((await send(primary)).data, first.data)
  assert.equal((await send({ ...primary, actionId: 'wait' })).status, 409)
  assert.equal((await req(path + '/actions', { ...action('wait', 2), parameters: { extra: true } })).status, 400)

  // Reject an event insert after the session UPDATE and verify that every write rolls back.
  const fault = 'reject_' + randomUUID().replaceAll('-', '')
  await pool().query(`ALTER TABLE session_events ADD CONSTRAINT ${fault}
    CHECK (session_id <> '${created.data.id}'::uuid OR seq < ${(await req(path)).data.timeline.length})`)
  const transport = action('transport', 2)
  try {
    assert.equal((await send(transport)).status, 500)
    assert.equal((await req(path)).data.revision, 2)
    assert.equal((await req(path)).data.transport, created.data.transport)
  } finally {
    await pool().query(`ALTER TABLE session_events DROP CONSTRAINT ${fault}`)
  }
  assert.equal((await send(transport)).data.revision, 3)

  const next = structuredClone(scenario)
  next.info.version = version + 1
  next.info.title = 'Versi pengujian'
  await pool().query('INSERT INTO case_versions VALUES ($1,$2,$3)', [next.info.id, next.info.version, next])
  try {
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
  } finally {
    await pool().query('DELETE FROM case_versions WHERE case_id=$1 AND version=$2', [next.info.id, next.info.version])
  }
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
