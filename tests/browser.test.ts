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
  await button('Delegasikan panggilan ke RS utama 0 mnt').click()
  await page.getByText('Panggilan ke RS utama', { exact: true }).waitFor()
  const currentId = await page.evaluate(() => sessionStorage.getItem('jaga-session'))

  const secondTab = await context.newPage()
  await secondTab.goto(page.url())
  await secondTab.getByRole('button', { name: 'Lanjutkan', exact: true }).click()
  await secondTab.getByRole('button', { name: 'Aksi', exact: true }).click()
  const secondWait = secondTab.getByRole('button', { name: 'Tunggu 5 menit 5 mnt', exact: true })

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
  await button('Aksi').click()
  await button('Nilai ulang pasien 5 mnt').click()
  await button('Rujukan').click()
  await page.getByRole('heading', { name: 'Temuan sejak handover terakhir' }).waitFor()
  await button('Perbarui handover').click()
  await page.getByText('RS utama · +14 mnt', { exact: true }).waitFor()
  await button('Aksi').click()
  for (const minute of [19, 24, 29, 34]) {
    await button('Tunggu 5 menit 5 mnt').click()
    await page.locator('.clock').getByText(`+${minute} mnt`, { exact: true }).waitFor()
  }
  await button('Selesaikan transfer 2 mnt').click()
  await page.locator('.outcome').getByText('Transfer ke RS utama selesai.').waitFor()
  await button('Ulang kasus').click()
  await page.locator('.clock').getByText('+00 mnt', { exact: true }).waitFor()
  assert.notEqual(await page.evaluate(() => sessionStorage.getItem('jaga-session')), currentId)
  await button('Riwayat').click()
  await button('Lihat hasil').click()
  await page.locator('.outcome').getByText('Transfer ke RS utama selesai.').waitFor()
})
