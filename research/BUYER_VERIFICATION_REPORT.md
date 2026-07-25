# Verifikasi Independen Sisi Pembeli — Quiver (ASP #5152)
### Pengukuran ulang klaim perbaikan, termasuk koreksi atas kesalahan pengukur sendiri

**Pengukur**: agen pembeli otonom ("Sentinel"), wallet `0xba3ae4e9ff20d14b391bd9fd2dac71faa20b1f9b` (X Layer / eip155:196)
**Periode**: 2026-07-21 → 2026-07-25 · **Build server saat verifikasi**: `q1-bce7e7bccb16ea1b`
**Posisi**: pembeli pihak ketiga yang membayar sendiri tiap panggilan. Tidak punya akses server, log vendor, atau kredensial internal.

> **Cara membaca dokumen ini.** Setiap angka disertai sumber mentahnya. Bagian §1 adalah **koreksi atas klaim keliru pengukur sendiri** — dimuat lebih dulu karena kredibilitas sisa dokumen bergantung padanya. §7 memuat batasan yang tidak bisa dibuktikan dari kursi pembeli. Bila dua nilai sama-sama masuk akal, dokumen ini memakai yang **lebih merugikan Quiver**.

---

## 1. KOREKSI DIRI: klaim "kebocoran ~11%" milik kami SALAH

**Klaim awal kami** (BUG_JOURNAL.md, ID BUG-011, 2026-07-23): kebocoran settlement ≈ **11%** — respons berbayar terkirim tanpa uang mendarat.

**Klaim itu cacat metodologi.** Kami memakai endpoint riwayat wallet agregat (`onchainos wallet history`, paginasi penuh) sebagai kebenaran on-chain. Endpoint itu **tidak lengkap**.

**Bukti cacatnya** — kami ambil 8 tx hash yang "tidak ditemukan" di riwayat agregat, lalu menanyakannya satu per satu:

| tx hash (16 char pertama) | Hasil kueri individual |
|---|---|
| `0x048f187ae627b4cb…` | SUCCESS on-chain |
| `0x0737870b4d48822e…` | SUCCESS on-chain |
| `0x0afbc4ebe4329213…` | SUCCESS on-chain |
| `0x0d29efa6ebed0b9b…` | SUCCESS on-chain |
| `0x104b9f74a0a6ec3a…` | SUCCESS on-chain |
| `0x1120099c0562768c…` | SUCCESS on-chain |
| `0x121c9e829ecfcba2…` | SUCCESS on-chain |
| `0x131bbb4a5d8edf2b…` | SUCCESS on-chain |

**8 dari 8 ada.** Riwayat agregat melewatkan 47 transfer yang sebenarnya ada → selisih yang kami kira "kebocoran" sebagian besar adalah **lubang di API riwayat**, bukan uang yang tidak dibayar.

### Pengukuran ulang dengan dua metode independen

**Metode A — berbasis baris ledger** (tidak bergantung API riwayat sama sekali): hitung baris yang kami catat `settled` tetapi server tidak pernah memberi tx hash.

| | |
|---|---|
| Baris `settled` (seluruh periode) | **1.089** |
| Di antaranya tanpa tx hash | **88** → **8,08% per hitungan** |
| Nilai baris tanpa tx hash | **0,880 USDT** → **6,84% per nilai** |

**Metode B — identitas saldo** (tidak bergantung API riwayat maupun ledger klaim):

```
didanai 30,2 USDT
− saldo akhir 13,197421 USDT
= total keluar 17,002579 USDT
− arus trading netto 4,9747 USDT (dikonversi ke OKB, bukan hilang)
= benar-benar ke Quiver 12,0279 USDT
ledger mengklaim 12,8650 USDT
→ GAP 0,8371 USDT = 6,51%
```

**Dua metode konvergen**: 0,880 USDT (A) vs 0,8371 USDT (B) — selisih 0,043 USDT, sepadan dengan panggilan desk yang terjadi di antara dua pembacaan.

### Vonis

| Klaim | Nilai | Status |
|---|---|---|
| Klaim awal kami | ~11% | **SALAH — ditarik.** Metodenya memakai API riwayat yang terbukti bolong |
| Klaim vendor (diberikan ke kami) | 7,0% | **Pada dasarnya benar** — sejalan dengan pengukuran independen kami |
| **Pengukuran independen kami (konservatif)** | **8,08% per hitungan / 6,84% per nilai** | Dua metode independen konvergen |

**Catatan aritmetika**: vendor menyebut "7,0% — 68 dari 818 baris". 68/818 = 8,31% per hitungan, bukan 7,0%; 7,0% konsisten sebagai angka **per nilai**. Angka per-hitungan dan per-nilai berbeda karena panggilan mahal (mis. portfolio-gate 0,05) tersebar tidak merata. Dokumen ini memakai **8,08% (per hitungan)** sebagai headline karena itu yang paling merugikan Quiver.

*Sumber mentah: `state/ledger.csv`, `state/reconcile_final.json`, skrip `agent/reconcile.py`.*

---

## 2. Sesudah perbaikan: gap menuju nol

Perbaikan vendor (tx-hash-gated settle + satu retry idempoten EIP-3009, lalu 402 not-charged) di-deploy sebelum 2026-07-25.

| Periode | Baris `settled` | Tanpa tx hash | % |
|---|---:|---:|---:|
| 2026-07-21 | 250 | 18 | 7,20% |
| 2026-07-22 | 503 | 43 | 8,55% |
| 2026-07-23 | 249 | 27 | 10,84% |
| **2026-07-25 (pasca-fix)** | **87** | **0** | **0,00%** |

**Verifikasi tambahan pasca-fix**: 12 tx hash diambil acak (seed tetap 7) dari 87 panggilan hari itu, tiap-tiap dikueri individual → **12/12 SUCCESS on-chain**. Contoh: `0xe195c62596c1753cac6dea95d435ac6f7def3e324f35063e8317d151c3575314` (size-gate, 05:07:28Z).

### 2a. Jendela terkontrol — bukti terkuat pasca-fix

Pengukuran tertutup: catat saldo on-chain + total ledger pada T0, biarkan desk berjalan normal, catat ulang pada T1. Tidak ada fill trading dalam jendela ini (saldo OKB tidak berubah: `0.0785300448150263` di kedua ujung), jadi seluruh perubahan saldo USD₮0 murni pembayaran Quiver.

| | |
|---|---|
| Jendela | 2026-07-25T05:12:55Z → 05:38:08Z (25 menit) |
| Panggilan berbayar baru | **16** |
| Ledger mengklaim | **0,195000 USDT** |
| Saldo on-chain turun | **0,195000 USDT** |
| **GAP** | **0,000000 USDT** |
| Baris tanpa tx hash | **0** |

Klaim dan realitas **cocok sampai sen terakhir**. Ini bentuk pengujian yang paling sulit dimanipulasi: tidak bergantung pada API riwayat, tidak bergantung pada field respons, dan tidak terkontaminasi arus trading.

*Sumber mentah: `state/ledger.csv` baris ber-timestamp `2026-07-25T*`, `state/window_t0.json`, `state/window_result.json`.*

---

## 3. Klaim vendor yang kami uji ulang sendiri

Setiap baris diuji dengan **saldo on-chain sebelum & sesudah**, bukan dengan mempercayai field respons.
*Sumber mentah: `state/fix_verification.json` (memuat request, HTTP, header settle, saldo b/a per tes).*

| # | Klaim vendor | Uji kami | Hasil | Vonis |
|---|---|---|---|---|
| 1 | Settle tidak lagi menerima `success:true` tanpa tx hash | Panggilan valid `size-gate`; periksa header + saldo + tx on-chain | Ditagih tepat 0,01; `status:"settled"` + tx `0xe195c625…` terkonfirmasi SUCCESS | ✅ Terkonfirmasi |
| 2 | loop-digest pembacaan nol-baris → `ok:false` + `NO_DATA` + coverageNote + **GRATIS** | `{"wallet":"0xba3a…","chain":"xlayer"}`; saldo b/a | HTTP 200, **ditagih 0,000000**, `verdict:"NO_DATA"`, `status:"not_charged"`, coverageNote menjelaskan cakupan indeks | ✅ Terkonfirmasi |
| 3 | Guard endpoint-salah: options-desk & updown-pulse menolak subjek asing, gratis | 3 panggilan: currency=alamat kontrak; coin=DOGE; body kosong | Ketiganya HTTP **400**, **ditagih 0,000000** | ✅ Terkonfirmasi |
| 4 | Pesan penolakan memuat identitas layanan + bentuk input | Baca isi `detail` pada penolakan | Menyebut nama layanan, cakupannya, **dan menunjuk layanan yang benar** (contoh di bawah) | ✅ Terkonfirmasi |
| 5 | protocol-pulse: alias berganti nama + peringkat TVL → 32/32 dosir | Spot-check 3: makerdao, frax, uniswap | `makerdao` → resolusi **"Sky Lending"** ✓; `frax` → "Frax" ✓; `uniswap` → `DATA_UNAVAILABLE` (timeout DefiLlama) — **tidak ditagih** | 🟡 Sebagian: alias terbukti bekerja; **klaim 32/32 tidak dapat kami verifikasi** (§7) |
| 6 | Build tetap `q1-bce7e7bccb16ea1b`, codeHash tidak berubah | `GET /build` + hitung ulang dari klon repo | Cocok: respons = klon = `/build` | ✅ Terkonfirmasi sendiri |

**Contoh pesan penolakan (klaim #4), verbatim:**
> `updown-pulse covers BTC and ETH only, not "DOGE". For perp liquidation risk use /api/perp-gate; for a DeFi protocol health check (e.g. aave) use /api/protocol-pulse.`

> `currency is required (BTC | ETH | SOL). This endpoint returns crypto OPTIONS analytics only. For a DeFi protocol health check (e.g. aave, lido, gmx) use /api/protocol-pulse; for token safety use /api/token-scan.`

**Temuan tambahan (di luar daftar vendor)**: kegagalan upstream transien kini juga ditangani jujur — `protocol-pulse` mengembalikan `verdict:"DATA_UNAVAILABLE"` dengan catatan `"DefiLlama upstream unavailable … Transient — retry"` dan **tidak menagih** (baris ledger `2026-07-25T05:24:03Z status=not_charged`).

---

## 4. Integritas kriptografis — terus diuji, tetap utuh

Sepanjang seluruh sesi, **tiap** respons berbayar diverifikasi ulang secara independen memakai SDK open-source dari klon repo publik: hitung ulang `contentHash`, cek ulang seluruh `selfChecks`, pulihkan penanda tangan dari signature, bandingkan `codeHash` respons vs klon vs `/build`, dan untuk engine deterministik jalankan ulang engine-nya lalu bandingkan byte-per-byte.

| | |
|---|---|
| Verifikasi tercatat `verify=OK` di log desk | **983** |
| Verifikasi gagal | **0** |
| Berkas `state/verify_failures.jsonl` | kosong (0 baris) |

Termasuk **lintas deploy**: setelah vendor mengganti build (`q1-7847bc790cd06cdc` → `q1-bce7e7bccb16ea1b`), `git pull` pada klon repo langsung mereproduksi codeHash baru — rantai reproduktibilitas tidak putus.

*Sumber mentah: `state/desk_log.txt` (grep `verify=OK`), alat `agent/verify.mjs`, klon `vendor/quiver`.*

---

## 5. Cara memverifikasi ulang sendiri (perintah persis)

Siapa pun dapat mengulang seluruh pemeriksaan di atas. Butuh Node ≥20, Python 3, dan CLI `onchainos` dengan wallet berdana di X Layer.

**A. Build & reproduktibilitas engine**
```bash
curl -s https://quiver-production-c3a8.up.railway.app/build
git clone https://github.com/Tristan-tech-ai/Quiver.git && cd Quiver
node --input-type=module -e "const {_internal}=await import('./src/engine/proof.js'); console.log(_internal.buildId())"
# harus sama dengan codeHash dari /build
```

**B. Verifikasi envelope sebuah respons berbayar** (setelah menyimpan body ke `resp.json`)
```bash
node -e "
import('./sdk/index.js').then(async ({createRiskBrain})=>{
  const rb=createRiskBrain(); const r=JSON.parse(require('fs').readFileSync('resp.json','utf8'));
  console.log('verify   :', rb.verify(r));      // contentHash + selfChecks
  console.log('reproduce:', rb.reproduce(r));   // jalankan ulang engine, harus byte-identik
})"
```

**C. Guard tidak menagih** (ganti alamat wallet dengan milik Anda)
```bash
onchainos wallet balance --chain xlayer          # catat saldo USD₮0
# panggil endpoint dengan subjek salah, lalu:
onchainos wallet balance --chain xlayer          # saldo harus TIDAK berubah
```

**D. loop-digest pembacaan kosong gratis**
```bash
# saldo sebelum → POST /api/loop-digest {"wallet":"<anda>","chain":"xlayer"} → saldo sesudah
# harapkan: HTTP 200, verdict NO_DATA, header PAYMENT-RESPONSE status "not_charged", saldo tetap
```

**E. Settlement benar mendarat** (kunci: kueri hash **satu per satu**, jangan pakai riwayat agregat)
```bash
onchainos wallet history --chain xlayer --tx-hash <hash-dari-header-PAYMENT-RESPONSE>
# harapkan txStatus SUCCESS dan tujuan = payTo yang diiklankan
```
> ⚠️ **Peringatan metodologi bagi peneliti berikutnya**: `onchainos wallet history` berpaginasi **tidak lengkap** — ia melewatkan transaksi yang benar-benar ada (kami buktikan 8/8). Jangan pernah memakainya sebagai kebenaran on-chain. Pakai kueri per-hash, atau identitas saldo.

**F. Skrip kami** (dapat dijalankan ulang apa adanya)
```bash
py agent/verify_fixes.py     # tes saldo b/a untuk guard + loop-digest + kontrol berbayar
py agent/reconcile.py        # rekonsiliasi ledger vs on-chain, tulis state/reconcile_final.json
```

---

## 6. Pemisahan tegas: diukur sendiri vs diterima dari vendor

**Kami ukur sendiri, dengan bukti mentah:**
- Tingkat kebocoran sebelum fix (dua metode independen), dan koreksi atas klaim kami sendiri
- Nol baris tanpa tx hash pada periode pasca-fix + 12 hash terverifikasi individual
- Guard & loop-digest tidak menagih (delta saldo on-chain = 0,000000)
- Isi pesan penolakan
- Alias `makerdao` → "Sky Lending"
- codeHash `/build` = klon repo
- 983 verifikasi envelope tanpa satu pun gagal

**Diterima dari vendor, TIDAK dapat kami verifikasi sendiri:**
- Angka internal "68 dari 818 baris" (kami tidak melihat log server; kami hanya bisa mencocokkan besarannya dengan pengukuran kami)
- Mekanisme "satu retry idempoten dengan nonce EIP-3009" — kami hanya melihat **hasilnya** (tiap klaim baru punya hash yang mendarat), bukan mekanismenya
- Klaim "32/32 dosir protocol-pulse lengkap"
- Klaim "3 deploy hari ini, masing-masing merestart container ~2–2,5 menit"
- Klaim bahwa setiap settle dicatat satu baris log di sisi vendor

---

## 7. Batasan jujur — yang TIDAK bisa kami buktikan dari kursi pembeli

1. **Kami tidak bisa membuktikan bahwa 88 baris tanpa tx hash itu benar-benar tidak pernah dibayar melalui jalur lain.** Yang kami tahu: server tidak memberi hash, dan identitas saldo menunjukkan uang sebesar itu memang tidak keluar. Keduanya konsisten, tapi bukan bukti log.
2. **Kami tidak bisa membedakan** "server tidak pernah mencoba settle" dari "settle gagal diam-diam" — dari luar keduanya terlihat sama.
3. **Sampel pasca-fix masih kecil**: 87 panggilan dalam ~1 hari, dibanding 1.002 panggilan pra-fix. Gap 0% pada sampel ini **belum** membuktikan gap 0% pada volume besar atau di bawah beban.
4. **Klaim "32/32"** tidak dapat diverifikasi pembeli: satu dari tiga spot-check kami justru kena timeout upstream (perilakunya jujur & gratis, tetapi dosirnya tidak lengkap saat itu). Kelengkapan bergantung pada uptime pihak ketiga (DefiLlama) pada saat panggilan.
5. **Estimasi arus trading** pada Metode B memakai asumsi ukuran fill (2,5 USDT per fill grid). Ini menyisakan ketidakpastian kecil (~0,04 USDT) pada angka identitas saldo.
6. **Uji beban tidak pernah terlaksana.** Rencana kami menjalankan 10 identitas pembeli terpisah secara bersamaan dibatalkan oleh gangguan infrastruktur di sisi penyedia rail (bukan Quiver). Karena itu, **tidak ada satu pun angka dalam dokumen ini yang mewakili perilaku di bawah konkurensi tinggi.**
7. **Kami tidak mengaudit kode server**, hanya artefak yang dapat diamati pembeli: respons HTTP, header pembayaran, envelope, dan pergerakan saldo on-chain.

---

## 8. Ringkasan angka

| Metrik | Nilai | Sumber |
|---|---|---|
| Panggilan berbayar (settled) | 1.089 baris ledger | `state/ledger.csv` |
| Nilai diklaim | 12,865 USDT | idem |
| Benar-benar mendarat (identitas saldo) | 12,028 USDT | perhitungan §1 Metode B |
| **Kebocoran pra-fix (konservatif)** | **8,08% per hitungan · 6,84% per nilai** | §1 |
| Kebocoran pasca-fix | **0 dari 87** panggilan | §2 |
| Jendela terkontrol pasca-fix | klaim 0,195 vs saldo −0,195 → **gap 0,000000** | §2a |
| Verifikasi envelope gagal | **0 dari 983** | `state/desk_log.txt` |
| Kegagalan validasi input yang menagih | **0** dari 4 uji guard | `state/fix_verification.json` |
| Pembacaan kosong loop-digest yang menagih | **0** | idem |

---

*Dokumen ini ditulis oleh pembeli, bukan oleh vendor. Semua berkas bukti yang dirujuk tersedia berdampingan dengan dokumen ini. Bila ada angka di sini yang tidak dapat Anda reproduksi dengan perintah di §5, perlakukan angka itu sebagai tidak terbukti.*
