import type { Debrief, Entry, Fact, Handover, Snapshot, Vital } from '../src/contracts'
import type { Scenario } from './scenario'

interface Scheduled { kind: string; minute: number; order: number }
export interface State {
  minute: number;
  receiver: 'idle' | 'calling' | 'unavailable' | 'primary' | 'alternate';
  transport: 'idle' | 'pending' | 'ready';
  assessments: number;
  facts: Fact[];
  vitals: Vital[];
  handover: Handover | null;
  handoverFacts: number;
  changes: Entry[];
  events: Entry[];
  queue: Scheduled[];
  next: number;
  outcome: string | null;
}

const receiverText = {
  idle: 'Belum dihubungi', calling: 'Sedang dihubungi', unavailable: 'RS utama belum bisa menerima',
  primary: 'RS utama siap menerima', alternate: 'RS alternatif siap menerima',
}
const transportText = { idle: 'Ambulans masih bertugas', pending: 'Ambulans dijadwalkan', ready: 'Ambulans siap' }
const taskText: Record<string, string> = { primary: 'Panggilan ke RS utama', alternate: 'Panggilan ke RS alternatif', ambulance: 'Menunggu ambulans' }

function record(s: State, id: string, text: string) {
  const event = { id, text, minute: s.minute }
  s.events.push(event)
  return event
}
function schedule(s: State, kind: string, minute: number) {
  s.queue.push({ kind, minute, order: s.next++ })
}

export function initial(d: Scenario): State {
  return {
    minute: 0, receiver: 'idle', transport: 'idle', assessments: 0,
    facts: [{ id: 'family', text: d.info.brief }],
    vitals: [{ ...d.initialVital, minute: 0 }], handover: null, handoverFacts: 0, changes: [],
    events: [{ id: 'arrival', minute: 0, text: d.info.brief }],
    queue: [{ kind: 'deadline', minute: d.deadline, order: 0 }], next: 1, outcome: null,
  }
}

function receiverReady(s: State) { return s.receiver === 'primary' || s.receiver === 'alternate' }
function handoverCurrent(s: State) { return !!s.handover && s.handoverFacts === s.facts.length }

function options(d: Scenario, s: State) {
  if (s.outcome) return []
  const conditions: Record<string, boolean> = {
    'receiver idle': s.receiver === 'idle',
    'phone free': s.receiver !== 'calling',
    'primary unavailable': s.receiver === 'unavailable',
    'assessment pending': s.assessments < d.reassessments.length,
    'transport idle': s.transport === 'idle',
    'receiver ready': receiverReady(s),
    'handover due': !handoverCurrent(s),
    'transport ready': s.transport === 'ready',
    'handover current': handoverCurrent(s),
    'time available': s.minute + (d.actions.find(a => a.id === 'transfer')?.duration ?? 0) < d.deadline,
  }
  return d.actions.filter(a => a.requires.every(rule => conditions[rule]))
}

function advance(d: Scenario, s: State, target: number) {
  s.queue.sort((a, b) => a.minute - b.minute || d.events[a.kind].priority - d.events[b.kind].priority || a.order - b.order)
  while (!s.outcome && s.queue.length && s.queue[0].minute <= target) {
    const event = s.queue.shift()!
    s.minute = event.minute
    switch (event.kind) {
      case 'primary':
        s.receiver = event.minute - d.events.primary.delay <= d.primaryCutoff ? 'primary' : 'unavailable'
        record(s, 'receiver', receiverText[s.receiver])
        break
      case 'alternate':
        s.receiver = 'alternate'
        record(s, 'receiver', receiverText.alternate)
        break
      case 'ambulance':
        s.transport = 'ready'
        record(s, 'ambulance', transportText.ready)
        break
      case 'reassess': {
        const { finding, vital } = d.reassessments[s.assessments]
        s.assessments++
        s.facts.push(finding)
        s.vitals.push({ ...vital, minute: s.minute })
        const entry = record(s, 'reassess', finding.text)
        if (s.handover) s.changes.push(entry)
        break
      }
      case 'deadline':
        s.outcome = d.outcomes.deadline
        record(s, 'outcome', s.outcome)
        break
    }
  }
  if (!s.outcome) s.minute = target
}

export function apply(d: Scenario, previous: State, id: string): State | null {
  const action = options(d, previous).find(a => a.id === id)
  if (!action) return null
  const s = structuredClone(previous)
  const target = s.minute + action.duration
  switch (action.id) {
    case 'primary':
    case 'alternate':
      s.receiver = 'calling'
      schedule(s, action.id, s.minute + d.events[action.id].delay)
      record(s, 'call', action.label)
      break
    case 'transport':
      s.transport = 'pending'
      schedule(s, 'ambulance', s.minute + d.ambulanceETA)
      record(s, 'transport', 'Persiapan transportasi dimulai.')
      break
    case 'reassess':
      schedule(s, 'reassess', target)
      record(s, 'assessment-start', 'Penilaian ulang dimulai.')
      break
  }
  advance(d, s, target)
  if (s.outcome) return s
  if (id === 'handover') {
    const vital = s.vitals.at(-1)!
    s.handover = {
      minute: s.minute, destination: s.receiver === 'primary' ? 'RS utama' : 'RS alternatif',
      sections: [
        { label: 'Situasi', text: s.facts[0].text },
        { label: 'Latar belakang', text: 'Fasilitas setempat tidak memiliki CT dalam skenario.' },
        { label: 'Penilaian', text: [...s.facts.slice(1).map(f => f.text), `Menit ${vital.minute} · Nadi ${vital.pulse} · TD ${vital.pressure} · RR ${vital.breathing} · SpO₂ ${vital.oxygen}%`].join(' ') },
        { label: 'Permintaan', text: 'Koordinasi penerimaan pasien dalam simulasi.' },
      ],
    }
    s.handoverFacts = s.facts.length
    s.changes = []
    record(s, 'handover', `Handover simulasi dikirim ke ${s.handover.destination}.`)
  }
  if (id === 'transfer') {
    s.outcome = s.receiver === 'primary' ? d.outcomes.primary : d.outcomes.alternate
    record(s, 'outcome', s.outcome)
  }
  return s
}

export function snapshot(d: Scenario, s: State, id: string, revision: number): Snapshot {
  return {
    id, revision, scenario: d.info, minute: s.minute, status: s.outcome ? 'finished' : 'active',
    condition: s.assessments > 0 ? 'Respons melambat saat dinilai ulang' : 'Keluarga melaporkan pasien makin mengantuk',
    facts: s.facts, vitals: s.vitals, receiver: receiverText[s.receiver], transport: transportText[s.transport],
    tasks: s.outcome ? [] : s.queue.filter(e => taskText[e.kind]).map(e => ({ id: e.kind, minute: e.minute, text: taskText[e.kind] })),
    timeline: s.events,
    options: options(d, s).map(({ id, label, duration }) => ({ id, label, duration })),
    handover: { latest: s.handover, changes: s.changes },
  }
}

export function debrief(d: Scenario, s: State): Debrief {
  if (!s.outcome) throw new Error('Session still active')
  const calls = s.events.filter(e => e.id === 'call')
  const coordination = s.events.filter(e => ['call', 'receiver', 'transport', 'ambulance'].includes(e.id))
  const handovers = s.events.filter(e => ['handover', 'reassess'].includes(e.id))
  const ending = s.events.filter(e => e.id === 'outcome')
  const evidence = (entries: Entry[]) => entries.length ? entries : [...s.events.slice(0, 1), ...ending]
  return {
    outcome: s.outcome, timeline: s.events,
    ratings: [
      { label: 'Prioritas', status: calls[0]?.minute <= d.primaryCutoff ? 'Tercapai' : calls.length ? 'Sebagian' : 'Terlewat', evidence: evidence(calls) },
      { label: 'Penilaian ulang', status: s.assessments > 0 ? 'Tercapai' : 'Terlewat', evidence: evidence(s.events.filter(e => e.id === 'reassess')) },
      { label: 'Koordinasi', status: receiverReady(s) && s.transport === 'ready' ? 'Tercapai' : coordination.length ? 'Sebagian' : 'Terlewat', evidence: evidence(coordination) },
      { label: 'Handover', status: handoverCurrent(s) ? 'Tercapai' : s.handover ? 'Sebagian' : receiverReady(s) ? 'Terlewat' : 'Tidak berlaku', evidence: evidence(s.handover ? handovers : s.events.filter(e => e.id === 'receiver')) },
    ],
  }
}
