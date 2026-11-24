import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CaseInfo, Debrief, Entry, SessionInfo, Snapshot, Vital } from './contracts'
import './style.css'

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

class RequestTimeout extends Error {}

async function api<T>(path: string, body?: object): Promise<T> {
  const signal = AbortSignal.timeout(15_000)
  try {
    const response = await fetch('/api' + path, {
      signal,
      ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const value = await response.json()
    if (!response.ok) throw new RequestError(response.status, value.error)
    return value
  } catch (error) {
    if (signal.aborted) throw new RequestTimeout('Permintaan terlalu lama. Coba lagi untuk memulihkan hasil.')
    throw error
  }
}

type Panel = 'Pasien' | 'Aksi' | 'Rujukan'
type Pending = { actionId: string; commandId: string; expectedRevision: number }
const panels: Panel[] = ['Pasien', 'Aksi', 'Rujukan']
const clock = (minute: number) => `+${String(minute).padStart(2, '0')} mnt`
type Creation = { caseId: string; version: number; creationId: string }
const creationKey = 'jaga-pending-creation'

function pendingCreation() {
  const stored = sessionStorage.getItem(creationKey)
  return stored ? JSON.parse(stored) as Creation : undefined
}

const pendingKey = (id: string) => 'jaga-pending:' + id

function Timeline({ entries, showDecision = false }: { entries: Entry[]; showDecision?: boolean }) {
  return <ol className="timeline">{entries.map((event, index) => <li key={index}>
    <div><time>{clock(event.minute)}</time>
      {event.decision && event.decision.endMinute !== event.minute && <><br /><small>sampai</small><br /><time>{clock(event.decision.endMinute)}</time></>}
    </div>
    <div>{event.text}{event.decision?.interrupted && ' · Terhenti saat waktu skenario berakhir'}
      {showDecision && event.decision && <details>
        <summary>Informasi saat memilih aksi</summary>
        <p>{event.decision.receiver} · {event.decision.transport}</p>
        <ul>{event.decision.facts.map(fact => <li key={fact.id}>{fact.text}</li>)}</ul>
        <p>Nadi {event.decision.vital.pulse} · TD {event.decision.vital.pressure} · RR {event.decision.vital.breathing} · SpO₂ {event.decision.vital.oxygen}%</p>
      </details>}
    </div>
  </li>)}</ol>
}

function VitalComparison({ before, after }: { before: Vital; after: Vital }) {
  const [beforeSystolic, beforeDiastolic] = before.pressure.split('/').map(Number)
  const [afterSystolic, afterDiastolic] = after.pressure.split('/').map(Number)
  const rows = [
    { label: 'Nadi (kali/menit)', previous: before.pulse, current: after.pulse },
    { label: 'Tekanan sistolik (mmHg)', previous: beforeSystolic, current: afterSystolic },
    { label: 'Tekanan diastolik (mmHg)', previous: beforeDiastolic, current: afterDiastolic },
    { label: 'Pernapasan (kali/menit)', previous: before.breathing, current: after.breathing },
    { label: 'Saturasi oksigen (%)', previous: before.oxygen, current: after.oxygen, deltaUnit: ' poin persentase' },
  ]
  return <div className="vitals" role="region" aria-label="Perbandingan tanda vital" tabIndex={0}>
    <table className="comparison">
      <caption>Selisih tanda vital sejak handover</caption>
      <thead><tr><th scope="col">Tanda vital</th><th scope="col">Terkirim (mnt {before.minute})</th><th scope="col">Terbaru (mnt {after.minute})</th><th scope="col">Selisih</th></tr></thead>
      <tbody>{rows.map(({ label, previous, current, deltaUnit }) => {
        const delta = current - previous
        const change = !Number.isFinite(delta) ? 'Tidak tersedia'
          : delta ? `${delta > 0 ? 'Naik' : 'Turun'} ${Math.abs(delta)}${deltaUnit ?? ''}` : 'Tetap'
        return <tr key={label}><th scope="row">{label}</th>
          <td>{Number.isFinite(previous) ? previous : '—'}</td><td>{Number.isFinite(current) ? current : '—'}</td>
          <td>{change}</td></tr>
      })}</tbody>
    </table>
  </div>
}

function App() {
  const [cases, setCases] = useState<CaseInfo[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [current, setCurrent] = useState<Snapshot>()
  const [brief, setBrief] = useState<CaseInfo>()
  const [result, setResult] = useState<Debrief>()
  const [panel, setPanel] = useState<Panel>('Pasien')
  const [history, setHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [needsSync, setNeedsSync] = useState(false)
  const [pending, setPending] = useState<Pending>()
  const [loading, setLoading] = useState(true)
  const lock = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const alert = useRef<HTMLDivElement>(null)
  const panelHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (message) alert.current?.focus()
  }, [message])
  const focusHeading = () => requestAnimationFrame(() => heading.current?.focus())

  async function list() {
    const data = await api<SessionInfo[]>('/sessions')
    setSessions(data)
  }

  function accept(state: Snapshot) {
    setCurrent(previous => previous?.id === state.id && previous.revision > state.revision ? previous : state)
  }

  function enterSession(state: Snapshot) {
    const stored = sessionStorage.getItem(pendingKey(state.id))
    setNeedsSync(false)
    setPending(stored ? JSON.parse(stored) as Pending : undefined)
    setBrief(undefined)
    setResult(undefined)
    setNotice('')
    setPanel('Pasien')
    accept(state)
    sessionStorage.setItem('jaga-session', state.id)
    focusHeading()
  }

  async function open(id: string) {
    enterSession(await api<Snapshot>('/sessions/' + id))
  }

  async function initialize() {
    setLoading(true)
    setMessage('')
    try {
      const [available] = await Promise.all([api<CaseInfo[]>('/cases'), list()])
      setCases(available)
      const creation = pendingCreation()
      if (creation) {
        await createSession(creation)
        return
      }
      const id = sessionStorage.getItem('jaga-session')
      if (id) {
        try { await open(id) }
        catch (error) {
          if (error instanceof RequestError && error.status === 404) sessionStorage.removeItem('jaga-session')
          throw error
        }
      }
    } catch (error) { showError(error) }
    finally { setLoading(false) }
  }

  useEffect(() => { void initialize() }, [])

  const finishedId = current?.status === 'finished' ? current.id : undefined
  async function loadDebrief(id: string, signal?: AbortSignal) {
    try {
      const data = await api<Debrief>(`/sessions/${id}/debrief`)
      if (!signal?.aborted) {
        setResult(data)
        return true
      }
    } catch (error) { if (!signal?.aborted) showError(error) }
  }

  useEffect(() => {
    if (!finishedId) return
    const controller = new AbortController()
    void loadDebrief(finishedId, controller.signal)
    return () => controller.abort()
  }, [finishedId])

  function showError(error: unknown) {
    setMessage(error instanceof RequestError || error instanceof RequestTimeout ? error.message : 'Koneksi terputus atau respons belum diterima. Coba lagi.')
  }

  async function run(task: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setMessage('')
    try { await task() } catch (error) { showError(error) }
    finally { lock.current = false; setBusy(false) }
  }

  async function createSession(creation: Creation) {
    sessionStorage.setItem(creationKey, JSON.stringify(creation))
    let state: Snapshot
    try {
      state = await api<Snapshot>('/sessions', creation)
    } catch (error) {
      if (error instanceof RequestError && error.status < 500) sessionStorage.removeItem(creationKey)
      throw error
    }
    enterSession(state)
    sessionStorage.removeItem(creationKey)
  }

  function start(info: CaseInfo) {
    return run(() => createSession(pendingCreation() ?? {
      caseId: info.id, version: info.version, creationId: crypto.randomUUID(),
    }))
  }

  async function syncSession(id: string) {
    try {
      const state = await api<Snapshot>('/sessions/' + id)
      accept(state)
      setNeedsSync(false)
      setNotice('Kondisi sesi terbaru sudah dimuat.')
      if (state.status === 'finished') focusHeading()
      else requestAnimationFrame(() => panelHeading.current?.focus())
    } catch {
      setMessage('Sesi berubah, tetapi kondisi terbaru belum dapat dimuat. Muat ulang kondisi sesi sebelum memilih aksi.')
    }
  }

  function act(actionId?: string) {
    if (!current || needsSync) return
    const previous = current
    return run(async () => {
      const payload = pending ?? (actionId && {
        actionId, commandId: crypto.randomUUID(), expectedRevision: previous.revision,
      })
      if (!payload) return
      const key = pendingKey(previous.id)
      const clear = () => { sessionStorage.removeItem(key); setPending(undefined) }
      sessionStorage.setItem(key, JSON.stringify(payload))
      setPending(payload)
      try {
        const state = await api<Snapshot>(`/sessions/${previous.id}/actions`, payload)
        clear()
        accept(state)
        if (state.revision > previous.revision) {
          setNotice(state.timeline.slice(previous.timeline.length).map(entry => entry.text).join(' ') || `Waktu simulasi ${clock(state.minute)}.`)
          if (state.status === 'finished') focusHeading()
        }
        if (state.status === 'active' && !actionId) requestAnimationFrame(() => panelHeading.current?.focus())
      } catch (error) {
        if (error instanceof RequestError && error.status < 500) {
          clear()
          if (error.status === 409 || error.status === 422) {
            setNeedsSync(true)
            await syncSession(previous.id)
            return
          }
        }
        throw error
      }
    })
  }

  function home(showHistory = false) {
    sessionStorage.removeItem('jaga-session')
    setCurrent(undefined)
    setBrief(undefined)
    setNotice('')
    setResult(undefined)
    setHistory(showHistory)
    void run(list)
    focusHeading()
  }

  const active = sessions.filter(s => s.status === 'active')
  const completed = sessions.filter(s => s.status === 'finished')
  const latest = current?.handover.latest
  const recentVital = current?.vitals.at(-1)
  const sentVital = latest && current?.vitals.slice().reverse().find(vital => vital.minute <= latest.minute)
  const debriefRetry = current?.status === 'finished' && !result && <button disabled={busy}
    onClick={() => void run(async () => {
      if (await loadDebrief(current.id)) focusHeading()
    })}>Coba muat debrief</button>
  const retry = current?.status === 'active' && (needsSync
    ? <button disabled={busy} onClick={() => void run(() => syncSession(current.id))}>Muat kondisi terbaru</button>
    : pending ? <button disabled={busy} onClick={() => void act()}>Coba ulang perintah</button> : null)

  function sessionList(items: SessionInfo[], label: string) {
    return <ul className="history">{items.map(item => <li key={item.id}>
      <div><strong>{item.title}</strong><small>{new Date(item.created).toLocaleString('id-ID')}</small></div>
      <button disabled={busy} onClick={() => void run(() => open(item.id))}>{label}</button>
    </li>)}</ul>
  }

  return <>
    <header className="top">
      <div className="top-inner"><button className="brand" disabled={busy} onClick={() => home()}><span aria-hidden="true">✚</span> Jaga IGD</button>
        <span className="draft">Draf simulasi</span>
        <button className="quiet" disabled={busy} onClick={() => home(true)}>Riwayat</button>
      </div>
    </header>
    <main>
      {message && <div className="alert" role="alert" ref={alert} tabIndex={-1}>
        <p>{message}</p>{!current ? <button onClick={() => void initialize()}>Muat ulang</button> : retry || debriefRetry}
      </div>}
      {loading && <p role="status">Memuat simulasi…</p>}
      {!loading && !current && !brief && !history && <section className="hero">
        <div className="hero-copy"><p className="eyebrow">SIMULASI DOKTER JAGA</p>
          <h1 ref={heading} tabIndex={-1}>Jaga IGD</h1>
          <p>Latihan penilaian ulang dan koordinasi rujukan di fasilitas terbatas.</p>
          {cases[0] && <div className="case-tile"><span>Kasus tersedia</span><h2>{cases[0].title}</h2><p>{cases[0].brief}</p><button className="primary" onClick={() => { setBrief(cases[0]); focusHeading() }}>Mulai kasus <span aria-hidden="true">→</span></button></div>}
          {active.length > 0 && <><h2>Sesi aktif</h2>{sessionList(active, 'Lanjutkan')}</>}
        </div>
        <div className="hero-art" aria-hidden="true"><div className="art-grid"><div className="pulse">∿</div><div className="art-mark">✚</div></div></div>
      </section>}
      {!current && brief && <section className="card intro">
        <p className="eyebrow">BRIEF KASUS</p><h1 ref={heading} tabIndex={-1}>{brief.title}</h1>
        <p>{brief.brief}</p><h2>Profil fasilitas</h2><p>{brief.facility}</p>
        <h2>Tujuan sesi</h2><p>Latih penilaian ulang, delegasi, persiapan transportasi, dan handover terstruktur.</p>
        <h2>Waktu simulasi</h2><p>Jam berjalan saat memilih aksi berdurasi atau Tunggu. Tugas yang didelegasikan dapat berjalan bersamaan dengan aksi lain.</p>
        <p className="muted">Data fiktif. Isi dan rubrik proses masih menunggu telaah klinis.</p>
        <button className="primary" disabled={busy} onClick={() => void start(brief)}>Masuk IGD</button>
      </section>}
      {!current && history && <section className="card">
        <h1 ref={heading} tabIndex={-1}>Riwayat kasus</h1>
        {active.length > 0 && <><h2>Sesi aktif</h2>{sessionList(active, 'Lanjutkan')}</>}
        <h2>Sesi selesai</h2>
        {completed.length ? sessionList(completed, 'Lihat hasil') : <p>Belum ada kasus selesai.</p>}
        <button onClick={() => home()}>Kembali ke pembuka</button>
      </section>}
      {current?.status === 'active' && <>
        <section className="summary">
          <div><p className="eyebrow">PASIEN SIMULASI</p><h1 ref={heading} tabIndex={-1}>{current.scenario.title}</h1><p>{current.condition}</p></div>
          <div className="clock"><span>Waktu simulasi</span><strong>{clock(current.minute)}</strong></div>
        </section>
        <nav className="tabs" aria-label="Panel kasus">{panels.map(name => <button key={name} aria-pressed={name === panel} onClick={() => setPanel(name)}>{name}</button>)}</nav>
        <div className="workspace">
          <section className="card">
            <h2 ref={panelHeading} tabIndex={-1}>{panel}</h2>
            {panel === 'Pasien' && <>
              <h3>Laporan singkat dan temuan</h3><ul>{current.facts.map(fact => <li key={fact.id}>{fact.text}</li>)}</ul>
              <h3>Tren tanda vital simulasi</h3>
              <div className="vitals" role="region" aria-label="Tren tanda vital simulasi" tabIndex={0}><table><thead><tr>{['Menit', 'Nadi', 'TD', 'RR', 'SpO₂'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{current.vitals.map(v => <tr key={v.minute}><td>{v.minute}</td><td>{v.pulse}</td><td>{v.pressure}</td><td>{v.breathing}</td><td>{v.oxygen}%</td></tr>)}</tbody></table></div>
              <p className="muted">Ambang dan aturan klinis menunggu telaah.</p>
            </>}
            {panel === 'Aksi' && <div className="actions">{current.options.map(option => <button key={option.id} disabled={busy || !!pending || needsSync} onClick={() => void act(option.id)}>{option.label}{option.resultInMinutes !== undefined
              ? <small>Hasil dalam {option.resultInMinutes} menit</small>
              : option.id !== 'wait' && option.duration > 0 && <small>{option.duration} mnt</small>}</button>)}</div>}
            {panel === 'Rujukan' && <>
              <dl className="referral"><div><dt>RS penerima</dt><dd>{current.receiver}</dd></div><div><dt>Transportasi</dt><dd>{current.transport}</dd></div></dl>
              <h3>Handover terakhir</h3>
              {latest ? <><p>{latest.destination} · {clock(latest.minute)}</p><dl>{latest.sections.map(section => <div key={section.label}><dt>{section.label}</dt><dd>{section.text}</dd></div>)}</dl></> : <p>Belum dikirim.</p>}
              {sentVital && recentVital && sentVital.minute !== recentVital.minute && <VitalComparison before={sentVital} after={recentVital} />}
              {current.handover.changes.length > 0 && <><h3>Temuan sejak handover terakhir</h3><Timeline entries={current.handover.changes}/></>}
              {current.options.some(option => option.id === 'handover') && <button className="primary" disabled={busy || !!pending || needsSync} onClick={() => void act('handover')}>{latest ? 'Perbarui handover' : 'Kirim handover simulasi'}</button>}
            </>}
            {!message && retry && <p className="retry">{retry}</p>}
          </section>
          <aside className="card">
            <h2>Tugas berjalan</h2>
            {current.tasks.length ? <Timeline entries={current.tasks} /> : <p className="muted">Tidak ada tugas berjalan.</p>}
            <h2>Kabar terbaru</h2>
            <p role="status">{notice || current.timeline.at(-1)?.text}</p>
          </aside>
        </div>
      </>}
      {current?.status === 'finished' && <section className="card">
        <p className="eyebrow">DEBRIEF · RUBRIK DRAF</p><h1 ref={heading} tabIndex={-1}>Hasil sesi</h1>
        {result ? <>
          <p className="outcome">{result.outcome}</p><h2>Penilaian proses</h2>
          <div className="ratings">{result.ratings.map(item => <article key={item.label}><h3>{item.label}</h3><strong>{item.status}</strong>{item.reason && <p>{item.reason}</p>}<Timeline entries={item.evidence} showDecision /></article>)}</div>
          <h2>Lini waktu sesi</h2><Timeline entries={result.timeline} showDecision />
          <button className="primary" disabled={busy} onClick={() => void start(current.scenario)}>Ulang kasus</button>
        </> : !message && <p role="status">Memuat debrief…</p>}
      </section>}
    </main>
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
