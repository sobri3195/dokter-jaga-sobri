import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CaseInfo, Debrief, Entry, SessionInfo, Snapshot } from './contracts'
import './style.css'

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch('/api' + path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined)
  const value = await response.json()
  if (!response.ok) throw new RequestError(response.status, value.error)
  return value
}

type Panel = 'Pasien' | 'Aksi' | 'Rujukan'
type Pending = { actionId: string; commandId: string; expectedRevision: number }
const panels: Panel[] = ['Pasien', 'Aksi', 'Rujukan']
const clock = (minute: number) => `+${String(minute).padStart(2, '0')} mnt`
const pendingKey = (id: string) => 'jaga-pending:' + id

function Timeline({ entries }: { entries: Entry[] }) {
  return <ol className="timeline">{entries.map((event, index) =>
    <li key={index}><time>{clock(event.minute)}</time><span>{event.text}</span></li>)}</ol>
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
  const [pending, setPending] = useState<Pending>()
  const [loading, setLoading] = useState(true)
  const lock = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const focusHeading = () => requestAnimationFrame(() => heading.current?.focus())

  async function list() {
    const data = await api<SessionInfo[]>('/sessions')
    setSessions(data)
  }

  function accept(state: Snapshot) {
    setCurrent(previous => previous?.id === state.id && previous.revision > state.revision ? previous : state)
  }

  async function open(id: string) {
    const state = await api<Snapshot>('/sessions/' + id)
    const stored = sessionStorage.getItem(pendingKey(id))
    setPending(stored ? JSON.parse(stored) as Pending : undefined)
    setResult(undefined)
    accept(state)
    setPanel('Pasien')
    sessionStorage.setItem('jaga-session', id)
    focusHeading()
  }

  async function initialize() {
    setLoading(true)
    setMessage('')
    try {
      const [available] = await Promise.all([api<CaseInfo[]>('/cases'), list()])
      setCases(available)
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
      if (!signal?.aborted) setResult(data)
    } catch (error) { if (!signal?.aborted) showError(error) }
  }

  useEffect(() => {
    if (!finishedId) return
    const controller = new AbortController()
    void loadDebrief(finishedId, controller.signal)
    return () => controller.abort()
  }, [finishedId])

  function showError(error: unknown) {
    setMessage(error instanceof RequestError ? error.message : 'Koneksi terputus atau respons belum diterima. Coba lagi.')
  }

  async function run(task: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setMessage('')
    try { await task() } catch (error) { showError(error) }
    finally { lock.current = false; setBusy(false) }
  }

  function start(info: CaseInfo) {
    return run(async () => {
      const state = await api<Snapshot>('/sessions', { caseId: info.id, version: info.version })
      setPending(undefined)
      setBrief(undefined)
      setResult(undefined)
      setNotice('')
      setPanel('Pasien')
      accept(state)
      sessionStorage.setItem('jaga-session', state.id)
      focusHeading()
    })
  }

  function act(actionId?: string) {
    if (!current) return
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
      } catch (error) {
        if (error instanceof RequestError && error.status < 500) {
          clear()
          if (error.status === 409 || error.status === 422) {
            accept(await api<Snapshot>('/sessions/' + previous.id))
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

  const active = sessions.find(s => s.status === 'active')
  const completed = sessions.filter(s => s.status === 'finished')
  const latest = current?.handover.latest

  return <>
    <header className="top">
      <div className="top-inner"><button className="brand" disabled={busy} onClick={() => home()}><span aria-hidden="true">✚</span> Jaga IGD</button>
        <span className="draft">Draf simulasi</span>
        <button className="quiet" disabled={busy} onClick={() => home(true)}>Riwayat</button>
      </div>
    </header>
    <main>
      {message && <div className="alert" role="alert">{message} {!current && <button onClick={() => void initialize()}>Muat ulang</button>}</div>}
      {loading && <p role="status">Memuat simulasi…</p>}
      {!loading && !current && !brief && !history && <section className="hero">
        <div className="hero-copy"><p className="eyebrow">SIMULASI DOKTER JAGA</p>
          <h1 ref={heading} tabIndex={-1}>Jaga IGD</h1>
          <p>Latihan penilaian ulang dan koordinasi rujukan di fasilitas terbatas.</p>
          {cases[0] && <div className="case-tile"><span>Kasus tersedia</span><h2>{cases[0].title}</h2><p>{cases[0].brief}</p><button className="primary" onClick={() => { setBrief(cases[0]); focusHeading() }}>Mulai kasus <span aria-hidden="true">→</span></button></div>}
          {active && <button disabled={busy} onClick={() => void run(() => open(active.id))}>Lanjutkan</button>}
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
        {completed.length ? <ul className=" history">{completed.map(item => <li key={item.id}><div><strong>{item.title}</strong><small>{new Date(item.created).toLocaleString('id-ID')}</small></div><button disabled={busy} onClick={() => void run(() => open(item.id))}>Lihat hasil</button></li>)}</ul> : <p>Belum ada kasus selesai.</p>}
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
            <h2>{panel}</h2>
            {panel === 'Pasien' && <>
              <h3>Laporan singkat dan temuan</h3><ul>{current.facts.map(fact => <li key={fact.id}>{fact.text}</li>)}</ul>
              <h3>Tren tanda vital simulasi</h3>
              <div className="vitals"><table><thead><tr>{['Menit', 'Nadi', 'TD', 'RR', 'SpO₂'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{current.vitals.map(v => <tr key={v.minute}><td>{v.minute}</td><td>{v.pulse}</td><td>{v.pressure}</td><td>{v.breathing}</td><td>{v.oxygen}%</td></tr>)}</tbody></table></div>
              <p className="muted">Ambang dan aturan klinis menunggu telaah.</p>
            </>}
            {panel === 'Aksi' && <div className="actions">{current.options.map(option => <button key={option.id} disabled={busy || !!pending} onClick={() => void act(option.id)}>{option.label}<small>{option.duration ? `${option.duration} mnt` : '0 mnt'}</small></button>)}</div>}
            {panel === 'Rujukan' && <>
              <dl className="referral"><div><dt>RS penerima</dt><dd>{current.receiver}</dd></div><div><dt>Transportasi</dt><dd>{current.transport}</dd></div></dl>
              <h3>Handover terakhir</h3>
              {latest ? <><p>{latest.destination} · {clock(latest.minute)}</p><dl>{latest.sections.map(section => <div key={section.label}><dt>{section.label}</dt><dd>{section.text}</dd></div>)}</dl></> : <p>Belum dikirim.</p>}
              {current.handover.changes.length > 0 && <><h3>Temuan sejak handover terakhir</h3><Timeline entries={current.handover.changes}/></>}
              {current.options.some(option => option.id === 'handover') && <button className="primary" disabled={busy || !!pending} onClick={() => void act('handover')}>{latest ? 'Perbarui handover' : 'Kirim handover simulasi'}</button>}
            </>}
            {pending && <p className="retry"><button disabled={busy} onClick={() => void act()}>Coba ulang perintah</button></p>}
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
          <div className="ratings">{result.ratings.map(item => <article key={item.label}><h3>{item.label}</h3><strong>{item.status}</strong><Timeline entries={item.evidence} /></article>)}</div>
          <h2>Lini waktu sesi</h2><Timeline entries={result.timeline} />
          <button className="primary" disabled={busy} onClick={() => void start(current.scenario)}>Ulang kasus</button>
        </> : message ? <button onClick={() => { setMessage(''); void loadDebrief(current.id) }}>Coba muat debrief</button> : <p role="status">Memuat debrief…</p>}
      </section>}
    </main>
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
