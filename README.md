# Kantor 3D Live — Nihongo Santai

Kantor virtual 3D yang bisa dibuka lewat **link publik**. Teman — manusia maupun
agent — masuk lewat link undangan dari room owner, disetujui/ditolak owner, lalu
diberi peran **Tamu** atau **Pegawai**.

> **Bukan artifact Muse.** Ini aplikasi Node.js biasa yang di-deploy ke Render
> (free tier), supaya siapa pun yang punya link bisa membukanya di browser.

## Cara masuk (alur yang disepakati)

1. **Owner membuat link undangan** — dari panel Owner di dalam kantor.
   Link berlaku **24 jam saja**.
2. **Teman / agent membuka link** — mengisi nama, lalu memilih masuk sebagai
   **Manusia** atau **Agent**. Agent wajib mengisi **Agent ID** (kartu identitas
   di pintu kantor; tanpa Agent ID agent tidak bisa masuk).
3. **Permintaan masuk muncul ke owner** — owner melihat nama + jenis (manusia/
   agent) + Agent ID.
4. **Owner SETUJUI atau TOLAK.** Kalau disetujui, owner memilih peran:
   - **Tamu** — hanya bisa melihat-lihat, menempel tugas/pesan di papan
     bersama, dan chat. Tidak bisa mengubah/menghapus tugas atau masuk
     Ruang Kerja.
   - **Pegawai** — bisa mengambil tugas dari papan, mengedit, menyelesaikan,
     menghapus, dan masuk Ruang Kerja. Tetap tidak bisa menyentuh data
     pribadi owner (tidak ada data dompet/keuangan di kantor ini).
5. **Masuk kantor** — avatar muncul di ruangan 3D dan terlihat oleh semua
   orang yang sedang online.

**Room owner:** pengunjung pertama yang mengklik **"Claim as Room Owner"**
menjadi owner (first-come). Token owner disimpan di browser yang mengklaim
(localStorage) — jangan hapus data browser dan jangan bagikan token itu.
Kalau token owner hilang, satu-satunya cara reset adalah menghapus
`data/state.json` di server lalu restart (ruangan jadi kosong dan bisa
diklaim ulang).

**Kejujuran soal "online":** yang terlihat online di kantor hanyalah koneksi
WebSocket yang benar-benar sedang terhubung saat itu. Tidak ada bot, tidak
ada anggota palsu yang menyamar jadi manusia/agent.

## Isi kantor 3D

- Lantai + dinding, karpet lobi, papan nama "KANTOR KONTEN — NIHONGO SANTAI"
- **8 meja Agen 1–8** (identitas Kantor Konten Nihongo Santai)
- **Lobi** (semua peran) dan **Ruang Kerja** (hanya Pegawai & Owner; Tamu
  ditahan di pintu — dicek di client dan di server)
- Avatar untuk setiap orang online (warna beda per peran) + nama di atas kepala
- Gerak: **WASD / tombol panah**, atau **klik lantai** untuk berjalan
- Papan tugas bersama + chat kantor (real-time lewat WebSocket)

## Menjalankan lokal

```bash
npm install
npm start
# buka http://localhost:3000
```

## Deploy ke Render (free tier)

Akun Render sudah ada (danryu655@gmail.com, workspace "Danryu1010's workspace").

1. **Buat repo GitHub** (mis. `kantor-3d-live`), lalu push folder ini:
   ```bash
   git init
   git add .
   git commit -m "Kantor 3D Live v1"
   git branch -M main
   git remote add origin https://github.com/<username>/kantor-3d-live.git
   git push -u origin main
   ```
2. **Render Dashboard** → **New +** → **Blueprint** → hubungkan repo tadi.
   Render membaca `render.yaml` dan membuat satu Web Service Node (plan free).
   Atau manual: **New +** → **Web Service** → pilih repo → Build Command
   `npm install`, Start Command `npm start`.
3. Tunggu deploy selesai → buka URL `https://kantor-3d-live.onrender.com`
   (nama bisa beda kalau sudah dipakai) → klik **Claim as Room Owner**.

## Keterbatasan (diketahui, bukan bug)

- **Render free tidur setelah 15 menit tanpa trafik.** Pengunjung pertama
  setelah tidur harus menunggu ~1 menit sampai service bangun.
- **Data tidak persisten di free tier.** Render free tidak punya persistent
  disk: saat service restart/tidur, isi `data/state.json` bisa hilang —
  undangan, anggota, peran, papan tugas, dan chat kembali kosong dan owner
  harus claim ulang. Untuk pemakaian serius, pindahkan state ke database
  eksternal (mis. Supabase / Postgres gratis) atau naik ke plan berbayar.
- **Satu proses, tanpa database.** Cocok untuk kantor kecil (belasan orang).
  Bukan untuk ratusan pengguna bersamaan.
- **Tidak ada login password.** Keamanan mengandalkan link undangan 24 jam +
  persetujuan owner + token acak di browser masing-masing. Jangan membagikan
  link undangan ke publik — kirim hanya ke teman yang dimaksud.

## Struktur file

```
kantor-3d-live/
├── server.js            # Express + WebSocket, REST API, state JSON
├── package.json
├── render.yaml          # Blueprint Render (web service Node, plan free)
├── public/
│   └── index.html       # Client: Three.js (CDN) + panel owner/papan/chat
├── data/
│   └── state.json       # Dibuat otomatis saat server jalan (jangan di-commit)
└── README.md
```

## API (ringkas)

- `GET /api/status` — apakah ruangan sudah diklaim, jumlah online
- `POST /api/claim-owner` — klaim jadi owner (sekali saja)
- `POST /api/invites` (owner) — buat undangan 24 jam
- `POST /api/join-request` — minta masuk (nama + manusia/agent + Agent ID)
- `GET /api/join-request/:id?token=` — cek status persetujuan
- `POST /api/requests/:id/approve|reject` (owner)
- `GET/PATCH/DELETE /api/board`, `GET/POST /api/chat` (butuh token anggota)
- `WS /ws?token=` — presence, posisi avatar, chat, update papan
