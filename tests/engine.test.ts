import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, debrief, initial, snapshot } from '../server/engine'
import { scenario } from '../server/scenario'

function play(actions: string[]) {
  let state = initial(scenario)
  for (const action of actions) {
    const next = apply(scenario, state, action)
    assert.ok(next, `Action ${action} unavailable at ${state.minute}`)
    state = next
  }
  return state
}

test('primary transfer with updated handover and hidden facts before discovery', () => {
  const pre = play(['primary', 'transport', 'wait', 'handover'])
  const dto = snapshot(scenario, pre, 'id', 4)
  assert.doesNotMatch(JSON.stringify(dto), /membuka mata|primaryCutoff|deadline|ratings/)
  const reassessed = apply(scenario, pre, 'reassess')!
  const after = snapshot(scenario, reassessed, 'id', 5)
  assert.equal(after.handover.changes[0].id, 'reassess')
  assert.doesNotMatch(JSON.stringify(after.handover.latest), /membuka mata/)
  assert.equal(apply(scenario, reassessed, 'transfer'), null)
  const done = play(['primary', 'transport', 'wait', 'handover', 'reassess', 'handover', 'wait', 'wait', 'wait', 'transfer'])
  assert.equal(done.outcome, scenario.outcomes.primary)
  assert.match(JSON.stringify(done.handover), /membuka mata/)
  assert.ok(debrief(scenario, done).ratings.every(rating => rating.status === 'Tercapai'))
})

test('doctor reassesses during delegated call and same-minute events use priority and sequence', () => {
  const calling = play(['primary'])
  assert.equal(calling.minute, 0)
  assert.equal(snapshot(scenario, calling, 'id', 1).tasks[0].id, 'primary')
  const after = apply(scenario, calling, 'reassess')!
  assert.deepEqual(after.events.filter(e => e.minute === 5).map(e => e.id), ['receiver', 'reassess'])
  const tie = structuredClone(scenario)
  tie.ambulanceETA = 5
  tie.events.ambulance.priority = tie.events.primary.priority
  const transportFirst = apply(tie, initial(tie), 'primary')!
  const waiting = apply(tie, transportFirst, 'transport')!
  waiting.queue.find(e => e.kind === 'ambulance')!.minute = 5
  assert.deepEqual(apply(tie, waiting, 'wait')!.events.filter(e => e.minute === 5).map(e => e.id), ['receiver', 'ambulance'])
})

test('a later call yields a playable alternate route', () => {
  const state = play(['transport', 'wait', 'wait', 'primary', 'reassess', 'alternate', 'wait', 'wait', 'handover', 'transfer'])
  assert.equal(state.outcome, scenario.outcomes.alternate)
})

test('unresolved barriers end at the deadline', () => {
  const state = play(Array<string>(12).fill('wait'))
  assert.equal(state.outcome, scenario.outcomes.deadline)
  assert.equal(state.minute, 60)
  assert.equal(apply(scenario, state, 'wait'), null)
  const review = debrief(scenario, state)
  assert.equal(review.ratings.at(-1)?.status, 'Tidak berlaku')
  assert.deepEqual(review.timeline.flatMap(e => e.decision ? [[e.minute, e.decision.endMinute]] : []),
    Array.from({ length: 12 }, (_, i) => [i * 5, (i + 1) * 5]))
})


test('transfer records its duration and handover explains missing reassessment', () => {
  const state = play(['primary', 'transport', 'wait', 'handover', ...Array<string>(4).fill('wait'), 'transfer'])
  const report = debrief(scenario, state)
  const transfer = report.timeline.find(event => event.decision?.actionId === 'transfer')!
  assert.equal(transfer.decision?.endMinute, transfer.minute + 2)
  const result = report.ratings.find(r => r.label === 'Handover')
  assert.equal(result?.status, 'Sebagian')
  assert.match(result?.reason ?? '', /Belum ada temuan penilaian ulang/)
  assert.deepEqual(result?.evidence.find(e => e.decision)?.decision?.facts.map(f => f.id), ['family'])
})

test('a deadline interrupts a decision at its actual end minute', () => {
  const state = play(['transport', ...Array<string>(12).fill('wait')])
  assert.equal(state.minute, 60)
  const event = state.events.filter(e => e.decision).at(-1)!
  assert.equal(event.minute, 57)
  assert.equal(event.decision?.endMinute, 60)
  assert.equal(event.decision?.interrupted, true)
})

test('priority rubric is independent of the primary hospital cutoff', () => {
  const scenarioWithoutPrimaryCapacity = { ...scenario, primaryCutoff: -1 }
  let state = initial(scenarioWithoutPrimaryCapacity)
  for (const id of ['primary', ...Array<string>(12).fill('wait')]) {
    state = apply(scenarioWithoutPrimaryCapacity, state, id)!
  }
  assert.equal(state.receiver, 'unavailable')
  assert.equal(debrief(scenarioWithoutPrimaryCapacity, state).ratings[0].status, 'Tercapai')
})
