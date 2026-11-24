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
  const event: Entry = { id, text, minute: s.minute }
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
  const entry = record(s, 'decision', action.label)
  const decision: NonNullable<Entry['decision']> = {
    actionId: id, endMinute: target, interrupted: false,
    facts: [...s.facts], vital: s.vitals.at(-1)!,
    receiver: receiverText[s.receiver], transport: transportText[s.transport],
  }
  entry.decision = decision
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
  decision.endMinute = s.minute
  decision.interrupted = !!s.outcome && (s.minute < target || id === 'handover')
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
    condition: s.assessments > 0 ? s.facts.at(-1)!.text : 'Keluarga melaporkan pasien makin mengantuk',
    facts: s.facts, vitals: s.vitals, receiver: receiverText[s.receiver], transport: transportText[s.transport],
    tasks: s.outcome ? [] : s.queue.filter(e => taskText[e.kind]).map(e => ({ id: e.kind, minute: e.minute, text: taskText[e.kind] })),
    timeline: s.events,
    options: options(d, s).map(({ id, label, duration }) => ({
      id, label, duration,
      ...((id === 'primary' || id === 'alternate') && { resultInMinutes: d.events[id].delay }),
    })),
    handover: { latest: s.handover, changes: s.changes },
  }
}

export function debrief(d: Scenario, s: State): Debrief {
  if (!s.outcome) throw new Error('Session still active')
  // Rubrik proses draf untuk kasus latihan ini. Batas ini tidak menentukan ketersediaan RS.
  const priorityWindow = 10
  const assessments = s.events.filter(e => e.id === 'reassess')
  const prioritySteps = s.events.filter(e => e.id === 'call' || e.id === 'assessment-start')
  const firstPriority = prioritySteps[0]
  const timely = firstPriority !== undefined && firstPriority.minute <= priorityWindow
  const coordination = s.events.filter(e => ['call', 'receiver', 'transport', 'ambulance'].includes(e.id))
  const ready = receiverReady(s) && s.transport === 'ready'
  const lastSend = s.events.map(e => e.id).lastIndexOf('handover')
  const handoverEvidence = lastSend < 0 ? s.events.filter(e => e.id === 'receiver')
    : s.events.slice(lastSend).filter(e => e.id === 'handover' || e.id === 'reassess')
  const current = handoverCurrent(s)
  const hasReassessment = s.handoverFacts > 1
  const evidence = (events: Entry[], actions: string[]) => {
    const linked = s.events.filter(entry => events.includes(entry) || actions.includes(entry.decision?.actionId ?? ''))
    if (linked.length) return linked
    const firstDecision = s.events.find(entry => entry.decision)
    return [s.events[0], ...(firstDecision ? [firstDecision] : []), ...s.events.filter(e => e.id === 'outcome')]
  }
  return {
    outcome: s.outcome, timeline: s.events,
    ratings: [
      {
        label: 'Prioritas', status: timely ? 'Tercapai' : firstPriority ? 'Sebagian' : 'Terlewat',
        reason: `Rubrik draf meminta penilaian ulang atau kontak RS dimulai dalam ${priorityWindow} menit pertama simulasi. ${firstPriority ? `Langkah pertama tercatat pada menit ${firstPriority.minute}.` : 'Kedua langkah belum dimulai saat sesi berakhir.'}`,
        evidence: evidence(prioritySteps, ['primary', 'alternate', 'reassess']),
      },
      {
        label: 'Penilaian ulang', status: assessments.length ? 'Tercapai' : 'Terlewat',
        reason: assessments.length ? `Penilaian ulang selesai pada menit ${assessments.map(e => e.minute).join(', ')}. Temuan baru tersedia sejak waktu tersebut.`
          : 'Rubrik meminta setidaknya satu penilaian ulang yang selesai. Tidak ada temuan penilaian ulang yang tersedia saat sesi berakhir.',
        evidence: evidence(assessments, ['reassess']),
      },
      {
        label: 'Koordinasi', status: ready ? 'Tercapai' : coordination.length ? 'Sebagian' : 'Terlewat',
        reason: `Rubrik meminta konfirmasi RS dan kesiapan transportasi. Saat sesi berakhir: ${receiverText[s.receiver]}; ${transportText[s.transport]}.`,
        evidence: evidence(coordination, ['primary', 'alternate', 'transport']),
      },
      {
        label: 'Handover', status: s.handover ? current && hasReassessment ? 'Tercapai' : 'Sebagian' : receiverReady(s) ? 'Terlewat' : 'Tidak berlaku',
        reason: s.handover
          ? `Handover terakhir dikirim pada menit ${s.handover.minute}. ${hasReassessment ? 'Temuan penilaian ulang saat pengiriman tercakup.' : 'Belum ada temuan penilaian ulang yang bisa disertakan saat pengiriman.'} ${current ? 'Tidak ada temuan baru setelah pengiriman.' : 'Temuan baru muncul setelah pengiriman dan belum diteruskan.'}`
          : receiverReady(s) ? 'RS sudah siap menerima, tetapi handover belum dikirim.' : 'Belum ada konfirmasi RS penerima yang memungkinkan pengiriman handover.',
        evidence: evidence(handoverEvidence, ['handover']),
      },
    ],
  }
}
