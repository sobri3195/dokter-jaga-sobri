# Jaga IGD

Simulasi edukasi berbahasa Indonesia untuk latihan dokter jaga di fasilitas terbatas. Kasus **Jatuh Sore, Mengantuk Tengah Malam** menggunakan data fiktif. Ambang klinis dan rubrik proses menunggu telaah. Semua aksi memakai pilihan yang tersedia dalam simulasi.

## Jalankan secara lokal

Gunakan Node.js 24, npm, dan Postgres. Contoh berikut membuat database lokal dengan Docker.

```sh
npm ci
docker run --rm -d --name jaga-igd-postgres \
  -e POSTGRES_USER=jaga -e POSTGRES_PASSWORD=jaga -e POSTGRES_DB=jaga_igd \
  -p 127.0.0.1:5432:5432 postgres:17
docker exec jaga-igd-postgres pg_isready -U jaga -d jaga_igd
cp .env.example .env
npm run db:setup
npm run dev
```

Buka `http://localhost:5173`. Vite meneruskan permintaan `/api` ke server pengembangan pada port 3001. Isi `APP_ORIGIN` dengan origin halaman yang tepat jika mengubah alamat. Simpan `DATABASE_URL` di sisi server. `.env` diabaikan oleh Git.

`npm run db:setup` menjalankan migrasi di `db/` dan menambahkan versi kasus dari `server/scenario.ts`. Jalankan kembali untuk setup yang sama. Untuk mengubah isi skenario yang sudah diterbitkan, naikkan nomor versi. Sesi lama tetap merujuk ke versi awalnya. Sesi yang dipilih melalui **Ulang kasus** memakai versi kasus yang diulang. Jika respons saat memulai atau mengulang kasus terputus, muat ulang tab atau coba lagi untuk memulihkan permintaan yang sama.

## Demonstrasi

1. Pilih **Mulai kasus**, baca brief, lalu pilih **Masuk IGD**.
2. Di **Aksi**, delegasikan panggilan ke RS utama dan nilai ulang pasien saat panggilan berlangsung. Kedua hasil muncul pada menit 5.
3. Siapkan transportasi. Di **Rujukan**, kirim handover awal pada menit 8.
4. Nilai ulang pasien sekali lagi. Kembali ke **Rujukan**, baca temuan baru, dan pilih **Perbarui handover**.
5. Pilih **Tunggu 5 menit** sampai ambulans siap, lalu selesaikan transfer. Baca debrief dan coba **Ulang kasus**.
6. Untuk jalur alternatif, mulai sesi baru, siapkan transportasi, tunggu dua kali, telepon RS utama, lalu nilai ulang. Hubungi RS alternatif setelah RS utama menyatakan belum siap. Tunggu sampai RS dan ambulans siap, kirim handover, lalu selesaikan transfer. Untuk luaran hambatan, tunggu sampai skenario berakhir.

## Verifikasi

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Untuk uji integrasi, gunakan database Postgres **khusus pengujian**. Tes menyisipkan versi sementara dan membuat sesi.

```sh
docker exec jaga-igd-postgres createdb -U jaga jaga_igd_test
DATABASE_URL=postgresql://jaga:jaga@127.0.0.1:5432/jaga_igd_test npm run db:setup
DATABASE_URL=postgresql://jaga:jaga@127.0.0.1:5432/jaga_igd_test npm run test:integration
```

Jalankan `npm run test:browser` dengan server pengembangan aktif. Uji pada lebar 360 piksel memakai Chromium sistem atau browser yang diinstal melalui `npx playwright-core install chromium`. Gunakan `CHROMIUM_PATH` untuk executable tertentu dan `BROWSER_URL` bila alamat aplikasi berbeda. GitHub Actions menjalankan pemeriksaan yang sama pada pull request dan push ke `main`.

## Vercel dan Neon

- Pilih preset **Vite**, Node.js 24, dan output `dist`. Vercel Function di `api/dispatch.ts` menangani rute API.
- Siapkan database Neon berbeda untuk Preview dan Production. Isi `DATABASE_URL` pada scope yang sesuai dengan connection string TLS dari Neon. Driver `pg` memakai koneksi TCP dan menjalankan setiap transaksi pada satu client.
- Atur `APP_ORIGIN` bila memakai satu domain tetap. Bila nilainya kosong di Vercel, API menggunakan host HTTPS deployment agar Preview per branch dapat menerima permintaan same-origin.
- Jalankan `npm run db:setup` dengan URL database target sebelum menggunakan deployment. Simpan kredensial di konfigurasi server Vercel dan jalankan migrasi melalui koneksi admin yang sesuai.
- Uji **Mulai kasus**, refresh sesi, aksi, dan debrief di Preview sebelum promosi ke Production. Verifikasi lokal memakai Postgres 17. Vercel Preview, telaah klinis (T12), dan uji peserta (T13) masih tertunda.

Untuk smoke test deployment, jalankan `SMOKE_URL=https://alamat-preview npm run test:deployment` setelah migrasi. Tes membuat satu sesi fiktif dan memeriksa cookie HTTPS, penolakan origin berbeda, refresh, pengiriman ulang perintah, konflik revisi, serta debrief. Gunakan Preview dengan database khusus Preview dan akses yang mengizinkan runner. Untuk browser, jalankan `BROWSER_URL=https://alamat-preview npm run test:browser`.

Debrief baru mencatat rentang waktu dan informasi yang terlihat saat aksi dipilih. Hasil yang sudah tersimpan tetap tersedia dalam format semula. Rubrik proses tetap berstatus draf hingga T12 dan T13 selesai.

## Operasional data

- Jalankan `npm run db:setup` sebelum deploy. Runner mengunci migrasi dan menyimpan checksum SHA-256. Buat file migrasi baru untuk perubahan berikutnya. Untuk database lama, migrasi 001 dan 002 yang idempoten dicatat saat setup pertama dengan ledger.
- Versi kasus yang sudah diterbitkan bersifat append-only dan mematok versi mesin beserta rubriknya. Untuk perubahan perilaku yang perlu dipisahkan dari sesi lama, terbitkan versi mesin baru dan versi kasus baru. Pertahankan implementasi mesin lama selama sesi yang merujuknya masih disimpan.
- Jalankan `npm run db:cleanup` untuk menghitung kandidat pembersihan. `npm run db:cleanup -- --apply` menghapus hingga 1.000 kandidat per tabel dalam satu transaksi. Atur jadwal harian di runner yang memakai database target. Bucket kuota disimpan 24 jam. Sesi tanpa aksi selama 90 hari dan identitas tamu yang tidak aktif selama 90 hari serta tidak memiliki sesi dapat dihapus. Penghapusan sesi juga menghapus peristiwa, perintah, dan debrief terkait. Saat migrasi dari skema lama, hitungan masa simpan sesi yang sudah ada dimulai dari waktu migrasi.
- Penerbitan cookie dibatasi 30 identitas baru per sumber per menit. Vercel memakai header alamat klien yang disediakan platform, sedangkan server lokal memakai alamat koneksi. Log backend mencatat operasi, kode galat database bila tersedia, dan `X-Request-Id` untuk korelasi tanpa mencetak cookie, payload, atau kredensial.
