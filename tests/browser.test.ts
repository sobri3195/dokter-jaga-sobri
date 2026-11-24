import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'

test('360px keyboard, interrupted request, refresh, debrief and repeat', async t => {
  const systemChromium = '/usr/bin/chromium'
  const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(systemChromium) ? systemChromium : undefined)
  const browser = await chromium.launch({ executablePath })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } })
  context.setDefaultTimeout(8000)
  const page = await context.newPage()
  await page.goto(process.env.BROWSER_URL ?? 'http://localhost:5173')
  const button = (name: string) => page.getByRole('button', { name, exact: true })
  await button('Mulai kasus').click()
  await button('Masuk IGD').click()
  await page.locator('.clock').getByText('+00 mnt', { exact: true }).waitFor()
  const patient = button('Pasien')
  await patient.focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.locator(':focus').innerText(), 'Aksi')
  assert.equal(await page.locator(':focus').evaluate(el => getComputedStyle(el).outlineStyle), 'solid')
  await page.keyboard.press('Enter')
  await button('Delegasikan panggilan ke RS utama Hasil dalam 5 menit').click()
  await page.getByText('Panggilan ke RS utama', { exact: true }).waitFor()
  const currentId = await page.evaluate(() => sessionStorage.getItem('jaga-session'))

  const secondTab = await context.newPage()
  await secondTab.goto(page.url())
  await secondTab.getByRole('button', { name: 'Lanjutkan', exact: true }).click()
  await secondTab.getByRole('button', { name: 'Aksi', exact: true }).click()
  const secondWait = secondTab.getByRole('button', { name: 'Tunggu 5 menit', exact: true })

  const attempts: string[] = []
  await page.route('**/api/sessions/*/actions', async route => {
    attempts.push(route.request().postDataJSON().commandId)
    if (attempts.length === 1) {
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      await route.abort()
    } else await route.continue()
  })
  await button('Nilai ulang pasien 5 mnt').click()
  await page.getByRole('alert').waitFor()
  await page.reload()
  await button('Coba ulang perintah').click()
  await page.getByText('Saat dinilai ulang, pasien membuka mata setelah dipanggil berulang.', { exact: true }).first().waitFor()
  assert.deepEqual(attempts, [attempts[0], attempts[0]])
  await page.unroute('**/api/sessions/*/actions')

  // The second tab still has revision 1. Fail its first snapshot reload after the conflict.
  const snapshotPath = '**/api/sessions/' + currentId
  await secondTab.route(snapshotPath, route => route.abort(), { times: 1 })
  await secondWait.click()
  await secondTab.getByRole('alert').getByText(/kondisi terbaru belum dapat dimuat/).waitFor()
  assert.equal(await secondWait.isDisabled(), true)
  await secondTab.getByRole('button', { name: 'Muat kondisi terbaru' }).click()
  await secondTab.locator('.clock').getByText('+05 mnt', { exact: true }).waitFor()
  assert.equal(await secondWait.isEnabled(), true)
  await secondTab.close()

  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 360)

  await button('Aksi').click()
  await button('Siapkan transportasi 2 mnt').click()
  await button('Rujukan').click()
  await button('Kirim handover simulasi').click()
  await page.getByText('RS utama · +08 mnt', { exact: true }).waitFor()
  assert.match(await page.locator('.summary').innerText(), /membuka mata setelah dipanggil berulang/)
  await button('Aksi').click()
  await button('Nilai ulang pasien 5 mnt').click()
  await button('Rujukan').click()
  await page.getByRole('heading', { name: 'Temuan sejak handover terakhir' }).waitFor()
  assert.match(await page.locator('.summary').innerText(), /jawaban pasien lebih singkat/)
  const comparison = page.getByRole('region', { name: 'Perbandingan tanda vital' })
  const comparisonTree = await comparison.ariaSnapshot()
  assert.match(comparisonTree, /table "Selisih tanda vital sejak handover"/)
  assert.match(comparisonTree, /columnheader "Terkirim \(mnt 5\)"/)
  assert.match(comparisonTree, /rowheader "Tekanan sistolik \(mmHg\)"/)
  assert.match(comparisonTree, /cell "Turun 1 poin persentase"/)
  await page.setViewportSize({ width: 320, height: 800 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320)
  assert.equal(await comparison.evaluate(el => el.scrollWidth > el.clientWidth), true)
  await comparison.focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => (document.activeElement?.scrollLeft ?? 0) > 0)
  await page.evaluate(() => { document.documentElement.style.fontSize = '' })
  await page.setViewportSize({ width: 360, height: 800 })
  await button('Perbarui handover').click()
  await page.getByText('RS utama · +14 mnt', { exact: true }).waitFor()
  assert.equal(await comparison.count(), 0)
  await button('Aksi').click()
  for (const minute of [19, 24, 29, 34]) {
    await button('Tunggu 5 menit').click()
    await page.locator('.clock').getByText(`+${minute} mnt`, { exact: true }).waitFor()
  }
  await page.route('**/api/sessions/*/debrief', route => route.abort(), { times: 1 })
  await button('Selesaikan transfer 2 mnt').click()
  await page.getByRole('alert').waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'alert')
  await page.keyboard.press('Tab')
  assert.equal(await page.locator(':focus').innerText(), 'Coba muat debrief')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement?.textContent === 'Hasil sesi')
  await page.locator('.outcome').getByText('Transfer ke RS utama selesai.').waitFor()
  await page.getByRole('article').filter({ hasText: 'Handover' })
    .getByText(/Temuan penilaian ulang saat pengiriman tercakup/).waitFor()
  const transferDecision = page.getByRole('listitem').filter({ hasText: 'Selesaikan transfer' })
  await transferDecision.getByText('+34 mnt', { exact: true }).waitFor()
  await transferDecision.getByText('+36 mnt', { exact: true }).waitFor()
  await transferDecision.getByText('Informasi saat memilih aksi').click()
  await transferDecision.getByText(/RS utama siap menerima · Ambulans siap/).waitFor()

  const creationIds: string[] = []
  await page.route(url => url.pathname === '/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    creationIds.push(route.request().postDataJSON().creationId)
    if (creationIds.length === 1) {
      const response = await route.fetch()
      assert.equal(response.status(), 201)
      await route.abort()
    } else await route.continue()
  })
  await button('Ulang kasus').click()
  await page.getByRole('alert').waitFor()
  await page.reload()
  await page.locator('.clock').getByText('+00 mnt', { exact: true }).waitFor()
  assert.equal(creationIds.length, 2)
  assert.equal(creationIds[0], creationIds[1])
  assert.notEqual(await page.evaluate(() => sessionStorage.getItem('jaga-session')), currentId)
  const history = await (await page.request.get(new URL('/api/sessions', page.url()).href)).json()
  assert.equal(history.length, 2)
  await button('Riwayat').click()
  await button('Lihat hasil').click()
  await page.locator('.outcome').getByText('Transfer ke RS utama selesai.').waitFor()
})

test('select an older active session and retry a hung mutation with the same ID', async t => {
  const path = '/usr/bin/chromium'
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (existsSync(path) ? path : undefined) })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } })
  await page.goto(process.env.BROWSER_URL ?? 'http://localhost:5173')
  const button = (name: string) => page.getByRole('button', { name, exact: true })
  const ids: (string | null)[] = []
  for (let i = 0; i < 2; i++) {
    await button('Mulai kasus').click()
    await button('Masuk IGD').click()
    await page.locator('.clock').waitFor()
    ids.push(await page.evaluate(() => sessionStorage.getItem('jaga-session')))
    await button('Jaga IGD').click()
    await button('Lanjutkan').nth(i).waitFor()
  }
  await button('Riwayat').click()
  await button('Lanjutkan').nth(1).click()
  await page.locator('.clock').waitFor()
  assert.equal(await page.evaluate(() => sessionStorage.getItem('jaga-session')), ids[0])
  await button('Aksi').click()

  // Shorten the browser timer while the route withholds the already committed response.
  await page.evaluate(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    AbortSignal.timeout = delay => timeout(Math.min(delay, 1200))
  })
  const attempts: string[] = []
  await page.route('**/api/sessions/*/actions', async route => {
    attempts.push(route.request().postDataJSON().commandId)
    if (attempts.length === 1) {
      const response = await route.fetch()
      assert.equal(response.status(), 200)
    } else await route.continue()
  })
  await button('Tunggu 5 menit').click()
  await page.getByRole('alert').getByText(/Permintaan terlalu lama/).waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'alert')
  await page.keyboard.press('Tab')
  assert.equal(await page.locator(':focus').innerText(), 'Coba ulang perintah')
  await page.keyboard.press('Enter')
  await page.locator('.clock').getByText('+05 mnt', { exact: true }).waitFor()
  await page.waitForFunction(() => document.activeElement?.textContent === 'Aksi')
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0], attempts[1])
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('a delayed first-visit list cannot replace the guest established by the other tab', { timeout: 30_000 }, async t => {
  const systemChromium = '/usr/bin/chromium'
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? (existsSync(systemChromium) ? systemChromium : undefined),
  })
  t.after(() => browser.close())
  const base = new URL(process.env.BROWSER_URL ?? 'http://localhost:5173').origin
  const context = await browser.newContext()
  const first = await context.newPage()
  const second = await context.newPage()
  const held = deferred<string | null>()
  const release = deferred<void>()
  await first.route(base + '/api/sessions', async route => {
    // An independent HTTP client keeps response headers out of the browser until fulfillment.
    const response = await fetch(route.request().url())
    const body = await response.text()
    held.resolve(response.headers.get('set-cookie'))
    await release.promise
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body })
  }, { times: 1 })

  await first.goto(base)
  const lateCookie = await held.promise
  const guestCookie = async () => (await context.cookies(base)).find(item => item.name === 'jaga_guest')?.value
  try {
    await second.goto(base)
    await second.getByRole('button', { name: 'Mulai kasus' }).click()
    await second.getByRole('button', { name: 'Masuk IGD' }).click()
    await second.locator('.clock').waitFor()
    const id = await second.evaluate(() => sessionStorage.getItem('jaga-session'))
    assert.ok(id)
    const guest = await guestCookie()
    assert.ok(guest)
    release.resolve(undefined)
    await first.getByRole('button', { name: 'Mulai kasus' }).waitFor()
    assert.equal(await guestCookie(), guest)
    assert.equal(lateCookie, null)
    await second.reload()
    await second.locator('.clock').waitFor()
    assert.equal(await second.evaluate(() => sessionStorage.getItem('jaga-session')), id)
  } finally {
    release.resolve(undefined)
  }
})

test('simultaneous first session creation waits for one guest cookie', { timeout: 30_000 }, async t => {
  const systemChromium = '/usr/bin/chromium'
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? (existsSync(systemChromium) ? systemChromium : undefined),
  })
  t.after(() => browser.close())
  const base = new URL(process.env.BROWSER_URL ?? 'http://localhost:5173').origin
  const context = await browser.newContext()
  const first = await context.newPage()
  const second = await context.newPage()
  const held = deferred<boolean>()
  const release = deferred<void>()
  await first.route(base + '/api/guests', async route => {
    const response = await fetch(route.request().url(), {
      method: 'POST', headers: { origin: base, 'Content-Type': 'application/json' }, body: '{}',
    })
    const body = await response.text()
    held.resolve(response.ok && response.headers.has('set-cookie'))
    await release.promise
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body })
  }, { times: 1 })

  try {
    for (const page of [first, second]) {
      await page.goto(base)
      await page.getByRole('button', { name: 'Mulai kasus' }).click()
    }
    await first.getByRole('button', { name: 'Masuk IGD' }).click()
    assert.equal(await held.promise, true)
    await second.getByRole('button', { name: 'Masuk IGD' }).click()
    await second.waitForFunction(async () => {
      const { pending } = await navigator.locks.query()
      return pending?.some(lock => lock.name === 'jaga-guest-bootstrap')
    })
    assert.equal((await context.cookies(base)).some(item => item.name === 'jaga_guest'), false)
    assert.equal(await second.locator('.clock').count(), 0)
    release.resolve(undefined)
    await Promise.all([first.locator('.clock').waitFor(), second.locator('.clock').waitFor()])
    const ids = await Promise.all([first, second].map(page => page.evaluate(() => sessionStorage.getItem('jaga-session'))))
    assert.ok(ids[0] && ids[1] && ids[0] !== ids[1])
    const list = await (await context.request.get(base + '/api/sessions')).json() as { id: string }[]
    assert.deepEqual(new Set(list.map(session => session.id)), new Set(ids))
  } finally {
    release.resolve(undefined)
  }
})
