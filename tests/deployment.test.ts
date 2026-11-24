import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { CaseInfo, Debrief, Snapshot } from '../src/contracts'

test('deployed API routes, guest cookie, replay, conflict, and debrief', async () => {
  const target = process.env.SMOKE_URL
  assert.ok(target, 'Set SMOKE_URL to the authorized deployment URL.')
  const url = new URL(target)
  assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  assert.equal(url.username + url.password, '')
  const { origin } = url
  let cookie = ''
  function request(path: string, body?: object, source = origin) {
    const headers: Record<string, string> = {}
    if (cookie) headers.cookie = cookie
    if (body) Object.assign(headers, { 'Content-Type': 'application/json', origin: source })
    return fetch(origin + '/api' + path, {
      headers, ...(body && { method: 'POST', body: JSON.stringify(body) }),
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
    })
  }
  const list = await request('/sessions')
  assert.equal(list.status, 200)
  assert.deepEqual(await list.json(), [])
  assert.equal(list.headers.get('set-cookie'), null)
  const unauthorizedOrigin = await request('/guests', {}, 'https://wrong-origin.invalid')
  assert.equal(unauthorizedOrigin.status, 403)
  assert.equal(unauthorizedOrigin.headers.get('set-cookie'), null)
  await unauthorizedOrigin.json()
  const bootstrap = await request('/guests', {})
  assert.equal(bootstrap.status, 200)
  assert.deepEqual(await bootstrap.json(), {})
  const issued = bootstrap.headers.get('set-cookie')
  assert.ok(issued)
  assert.ok(issued.includes('HttpOnly') && issued.includes('SameSite=Lax'))
  if (url.protocol === 'https:') assert.match(issued, /;\s*Secure(?:;|$)/i)
  assert.equal(list.headers.get('cache-control'), 'private, no-store')
  const firstCookie = issued.split(';')[0]
  const cases = await request('/cases')
  assert.equal(cases.status, 200)
  const [scenario]: CaseInfo[] = await cases.json()
  assert.ok(scenario)
  const creation = { caseId: scenario.id, version: scenario.version, creationId: randomUUID() }
  const anonymous = await request('/sessions', creation)
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.headers.get('set-cookie'), null)
  await anonymous.json()
  cookie = firstCookie
  const repeatedBootstrap = await request('/guests', {})
  assert.equal(repeatedBootstrap.status, 200)
  assert.equal(repeatedBootstrap.headers.get('set-cookie'), null)
  await repeatedBootstrap.json()
  const forbidden = await request('/sessions', creation, 'https://wrong-origin.invalid')
  assert.equal(forbidden.status, 403)
  await forbidden.json()
  const created = await request('/sessions', creation)
  assert.equal(created.status, 201)
  const session: Snapshot = await created.json()
  const path = '/sessions/' + session.id
  const first = { actionId: 'wait', commandId: randomUUID(), expectedRevision: 0 }
  const applied = await request(path + '/actions', first)
  assert.equal(applied.status, 200)
  const updated: Snapshot = await applied.json()
  assert.equal(updated.revision, 1)
  const replay = await request(path + '/actions', first)
  assert.equal(replay.status, 200)
  assert.deepEqual(await replay.json(), updated)
  const stale = await request(path + '/actions', { ...first, commandId: randomUUID() })
  assert.equal(stale.status, 409)
  await stale.json()
  const refresh = await request(path)
  assert.equal(refresh.status, 200)
  assert.equal((await refresh.json() as Snapshot).revision, 1)

  let state = updated
  for (let i = 0; i < 20 && state.status === 'active'; i++) {
    const action = await request(path + '/actions', {
      actionId: 'wait', commandId: randomUUID(), expectedRevision: state.revision,
    })
    assert.equal(action.status, 200)
    state = await action.json()
  }
  assert.equal(state.status, 'finished')
  const result = await request(path + '/debrief')
  assert.equal(result.status, 200)
  const report: Debrief = await result.json()
  assert.equal(report.timeline.filter(e => e.decision?.actionId === 'wait').length, state.revision)
  assert.ok(report.ratings.every(r => r.reason))
})
