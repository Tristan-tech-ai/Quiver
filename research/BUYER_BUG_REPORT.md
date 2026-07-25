# LAPORAN BUG KOMPREHENSIF — QA Sisi Pembeli terhadap Quiver (ASP #5152) & Funnel OKX.AI

**Periode**: 2026-07-21 05:30 UTC → 2026-07-23 01:30 UTC (berjalan; hari ke-2 dari mandat 3 hari)
**Metode**: buyer eksternal murni — hanya jalur publik (docs publik, endpoint x402 berbayar, marketplace OKX.AI, repo open-source). Tanpa akses internal apa pun. Setiap temuan berbukti mentah (arsip: `state/evidence/`, `state/ledger.csv`, `BUG_JOURNAL.md`).
**Lingkungan buyer**: wallet TEE `0xba3a...1f9b` (profil baru), egress VPN konsisten, verifikasi envelope independen via SDK resmi dari klon repo (contentHash + selfChecks + signature + reproduce + codeHash vs `/build`).
**Volume**: ±920 panggilan berbayar diklaim settle (ledger 9.2+ USDT), 687 transfer terkonfirmasi on-chain (8.235 USDT), 6 task marketplace, 4 round-trip trading riil, 22/22 layanan tersentuh.

> Penomoran di laporan ini dirapikan (jurnal mentah memakai BUG-009/010 dua kali). Kolom "Jurnal" = ID asli di BUG_JOURNAL.md.

---

## 1. Ringkasan eksekutif

Dua puluh temuan: **12 di sisi Quiver (Q)**, **6 di sisi ekosistem OKX.AI (E)**, plus catatan positif yang adil (§5). Tidak ada satu pun kegagalan integritas matematis/kriptografis — semua temuan berada di lapisan **operasional (ketersediaan, settlement), kontrak API (semantik HTTP, skema, penagihan), dan dokumentasi (drift docs vs perilaku)**. Tiga temuan berdampak uang langsung:

| Prioritas | ID | Satu kalimat |
|---|---|---|
| **P0** | Q-12 | ~11% respons berbayar kemungkinan terkirim TANPA settlement mendarat on-chain — kebocoran pendapatan sistemik |
| **P0** | Q-01 | Outage total ≥45 menit tanpa status page — konversi buyer baru = 0 selama jendela itu |
| **P1** | Q-09 | Input tak valid kadang GRATIS (500) kadang TERTAGIH (200 + `ok:false`) — biaya kegagalan tak terprediksi |
| **P1** | Q-11 | loop-digest menerima chain yang tak dicakupnya dan menagih untuk pembacaan kosong selamanya |
| **P1** | E-02/E-04 | Funnel marketplace menjatuhkan parameter layanan (dokumentasi menyuruh format yang justru gagal) |
| **P1** | E-03/E-05 | Auto-rating tanpa mandat, bisa faktual salah, tak bisa dimatikan buyer |

---

## 2. Temuan sisi QUIVER

### Q-01 · Outage total tanpa jejak — BLOCKER (selama jendela) · [Jurnal: BUG-001]
- **Kategori**: Availability. **Waktu**: 21 Jul ~05:30–06:20 UTC (≥45 menit teramati).
- **Bukti**: ≥9 request ke `/`, `/paper`, `/llms.txt`, `/mcp` → TCP+TLS tersambung <0.12s, **0 byte respons** hingga timeout 30–120s (`time_starttransfer=0`). Pembanding: GitHub instan dari egress sama. Pulih sendiri ~06:20; sesudahnya index 200/0.56s stabil ~44 jam.
- **Dampak**: buyer baru menganggap produk mati dan pergi; tanpa status page, tak ada cara membedakan "mati" vs "sebentar lagi pulih".
- **Rekomendasi**: healthcheck + auto-restart di Railway; halaman/endpoint status; alerting. Penyebab pasti butuh log server (di luar jangkauan buyer).

### Q-02 · Klaim reproduksi gagal di Windows default · minor (menyentuh klaim inti) · [BUG-002]
- **Kategori**: DOC-GAP reproduktibilitas.
- **Bukti**: `git clone` dengan `core.autocrlf=true` (default Windows) → buildId `q1-56cfd452a5aadbb2` ≠ `/build` `q1-7847bc790cd06cdc`. Checkout ulang LF → **cocok persis**. Repo tak punya `.gitattributes`; tak ada catatan line-ending di README/QUICKSTART/REPRODUCIBLE.
- **Dampak**: buyer Windows yang menunaikan "rebuild → identical codeHash" mendapat false alarm "kode live ≠ repo" — merusak kepercayaan tepat pada fitur andalan.
- **Rekomendasi**: commit `.gitattributes` (`* text=auto eol=lf` utk source), satu kalimat di REPRODUCIBLE.md.

### Q-03 · `bad_input` dibalas HTTP 500 · minor · [BUG-003]
- **Kategori**: BAD-ERROR (semantik HTTP).
- **Bukti**: perp-gate tanpa margin/leverage → `500 {"error":"engine_error","detail":"bad_input: require margin or leverage"}`. Pola sama di semua layanan (validasi pra-engine).
- **Dampak**: kesalahan klien tampil sebagai kerusakan server — monitoring buyer false-alarm; retry otomatis sia-sia. Di funnel marketplace, 500 inilah yang diteruskan ke notifikasi buyer (memperburuk E-02/E-03).
- **Rekomendasi**: `bad_input` → **400** dengan body sama. Satu baris mapping di handler.

### Q-04 · `outputSchema.required` tidak konsisten antar layanan · nit · [BUG-004]
- **Bukti**: mayoritas layanan mendeklarasikan `required` benar; **perp-gate tidak** (padahal punya constraint runtime margin-XOR-leverage → pemicu Q-03); portfolio-gate juga tidak (positions XOR account tak terekspresikan).
- **Rekomendasi**: lengkapi `required`/`oneOf`/`anyOf` di dua layanan itu; nilai `outputSchema` justru untuk validasi mesin buyer.

### Q-05 · Header settle `success:true` + `status:"timeout"` · minor → naik penting karena Q-12 · [BUG-005]
- **Bukti**: replay sukses pertama: `{"success":true,"transaction":"0x688f...55e0",...,"status":"timeout"}` — padahal settlement TERBUKTI mendarat (saldo 30.2→30.19).
- **Dampak**: status pembayaran ambigu — klien patuh-`status` bisa salah retry (risiko bayar dobel) atau salah dispute. Diduga label timeout tunggu-konfirmasi facilitator bocor ke status akhir. **Lihat Q-12: pola ini tampaknya juga menandai kasus yang benar-benar TIDAK settle — dua makna dalam satu label.**
- **Rekomendasi**: pisahkan `settleStatus ∈ {confirmed, pending, failed}` dari `deliveryStatus`; jangan pernah `success:true` bila settle belum terkonfirmasi ATAU dokumentasikan artinya.

### Q-06 · Drift docs input macro-sentry: `lookaheadHours` vs `hours` · minor · [BUG-006]
- **Bukti**: paper App. A Table 5 menulis `lookaheadHours`; skema 402 live: `hours` (+ `spot`, `atmIvPct` tak disebut paper).
- **Dampak**: buyer yang koding dari paper memakai field yang salah (diam-diam diabaikan → default).
- **Rekomendasi**: regenerasi Table 5 dari skema live (satu sumber kebenaran).

### Q-07 · macro-sentry ber-envelope `proof` tapi tak bisa direproduksi via SDK · minor · [BUG-008]
- **Bukti**: respons `deterministic:true` + klaim "re-run the open engine → reproduce exactly", tapi `macro-sentry` tidak ada di peta `ENGINES` `sdk/index.js` → `reproduce()` = `unknown engine`. (Hash, selfChecks, signature tetap lolos.)
- **Catatan doktrin**: kalender event berubah antar waktu — apakah seharusnya envelope `observation`? Paper sendiri menceritakan insiden serupa (portfolio-gate mode account dikoreksi ke observation).
- **Rekomendasi**: ekspor engine ke SDK ATAU turunkan ke observation envelope; jangan biarkan klaim yang tak bisa ditunaikan buyer.

### Q-08 · protocol-pulse 500 transien (upstream flakiness) · minor · [Jurnal: BUG-009 pertama]
- **Bukti**: `{"protocol":"uniswap"}` 12:04 → 500 `engine_error` (gratis); input identik 12:06 → sukses (`BASELINE`). aave/lido/gmx sukses.
- **Dampak**: kegagalan acak tanpa penjelasan (kemungkinan timeout DefiLlama dibungkus 500 generik). Mitigasi buyer yang terbukti cukup: retry-sekali.
- **Rekomendasi**: bedakan `upstream_timeout` (503/`retryable:true`) dari `engine_error`.

### Q-09 · Penagihan kegagalan tak konsisten: error kadang gratis, kadang berbayar · **MAJOR** · [Jurnal: BUG-010 pertama]
- **Kategori**: keadilan tagihan + konsistensi kontrak.
- **Bukti (5 probe input nakal)**:
  | Probe | Hasil | Tagihan |
  |---|---|---|
  | perp-gate `symbol:"DOGEMOON999"` | **200**, body `ok:false, errors:[...]` | **TERTAGIH 0.01** |
  | perp-gate `size:-5` | 500 | gratis |
  | size-gate `winProb:1.7` | **200**, `ok:false` + **proof envelope penuh** | **TERTAGIH 0.01** |
  | event-vol `spot:-100` | 500 | gratis |
  | updown `coin:"SOL"` | 500, pesan jelas | gratis |
- **Analisis**: dua jalur validasi — pra-engine (500, tak settle) vs dalam-engine (`{ok:false}` terstruktur, 200, settle). Kelas kesalahan buyer yang sama dihargai berbeda, tanpa dokumentasi. Semantik envelope juga aneh: proof T1 menandatangani "error yang benar".
- **Dampak**: buyer otomasi tak bisa menganggarkan biaya kegagalan; retry naif atas 200-`ok:false` membakar saldo.
- **Rekomendasi**: satu kebijakan terdokumentasi. Saran: SEMUA kegagalan validasi input → 400 gratis; 200+settle hanya untuk komputasi yang benar-benar dieksekusi. Minimal: dokumentasikan daftar kondisi `ok:false` berbayar.

### Q-10 · Drift docs output macro-sentry: `nextHighImpact` vs `nextEvent` · minor · [Jurnal: BUG-009 kedua]
- **Bukti**: paper menyebut output `events, nextHighImpact`; live: `nextEvent {kind,label,atUtc,hoursUntil}` + `nextEventRisk`. Parser kami (patuh paper) menghasilkan null 13 jam — fitur event-vol desk mati **tanpa error apa pun**.
- **Dampak**: kelas bug paling berbahaya bagi integrator — kegagalan senyap. Source engine akhirnya jadi dokumentasi de-facto.
- **Rekomendasi**: sama dengan Q-06 — Table 5 digenerasi dari kode.

### Q-11 · loop-digest menerima chain yang tak dicakup & menagih pembacaan kosong · **MAJOR** · [Jurnal: BUG-010 kedua]
- **Bukti**: 75 panggilan berbayar `{"wallet":"0xba3a...","chain":"xlayer"}` → SEMUA `txsFetched:0, newFills:[], pnlDrift:[]` — padahal wallet yang sama punya **740 order on-chain** (687 transfer + 8 leg swap DEX aggregator OKX) di periode itu per wallet-history API.
- **Analisis**: upstream market-API-nya tak mengindeks X Layer (konsisten: enum chain token-scan juga tanpa xlayer), tapi input `chain:"xlayer"` diterima tanpa penolakan/disclaimer. Mekanisme cursor-nya sendiri jujur (`cursorStatus`, `diffComplete` — teruji benar antar 75 panggilan); **cakupannya yang bohong-diam**.
- **Dampak**: 0.75 USDT untuk kehampaan; lebih buruk: false negative "tidak ada aktivitas" bagi agent yang mengandalkannya untuk rekonsiliasi. Ironis: chain yang tak dicakup adalah chain rail pembayarannya sendiri.
- **Rekomendasi**: whitelist chain → 400 utk yang tak dicakup; atau field `coverage` eksplisit + gratis bila `txsFetched:0` karena no-coverage.

### Q-12 · Dugaan kebocoran settlement ~11% (respons terkirim, uang tak pernah pindah) · **MAJOR (P0 vendor)** · [BUG-011]
- **Bukti**: ledger buyer 9.225 USDT diklaim settle (~920 panggilan + task marketplace) vs **transfer on-chain langsung ke payTo: 687 buah = 8.235 USDT**. Gap ≈ 0.99 (~11%). Saldo wallet buyer mengonfirmasi arah ini (21.61 aktual vs 20.97 teoritis-jika-semua-settle, sisanya PnL trading +0.025).
- **Analisis**: konsisten dengan Q-05 — layanan mengirim respons penuh ber-envelope valid saat settle facilitator timeout/gagal. Alternatif belum tereliminasi dari kursi buyer: sebagian settle via kontrak router/EntryPoint (tak tampak sebagai transfer langsung). **Log facilitator vendor bisa memastikan dalam hitungan menit.**
- **Dampak**: bila hipotesis timeout benar → ±1 dari 9 panggilan gratis diam-diam; membesar linear dengan volume.
- **Rekomendasi**: (1) audit silang log settle vs event Transfer USDT0→payTo; (2) kebijakan eksplisit deliver-vs-settle (tahan respons sampai settle terkonfirmasi, ATAU sadar-subsidi dan pantau ratenya); (3) perbaiki label Q-05 agar kasus ini terlihat.

---

## 3. Temuan sisi EKOSISTEM OKX.AI

### E-01 · Metrik SOLD: terjawab (menghitung x402 langsung, dengan lag) · informational · [ECO-001]
- Eksperimen delta: baseline SOLD 41 → 63 (+22) setelah ~21 settle x402 langsung + 6 task. **Hipotesis awal "hanya funnel marketplace yang dihitung" TERBANTAH** — x402 langsung ikut terhitung, dengan lag menit–jam. Sisa pertanyaan: kebijakan scrub self-buying retroaktif (terkonfirmasi ada oleh owner; parameternya tak diketahui buyer).

### E-02 · Auto-flow designated-x402 menjatuhkan parameter layanan · **MAJOR** · [ECO-002]
- **Bukti**: task perp-gate dengan `--service-params` teks natural → alur otomatis connect→agree→pay→replay **body kosong** → 500 → job menggantung `accepted`, tanpa auto-retry; notifikasi menyebut "kesepakatan tercapai, membayar" padahal chain tak mencatat transfer (state membingungkan). Pemulihan menuntut CLI manual (`task-402-pay --body`).
- **Dampak**: buyer non-teknis mentok; buyer teknis kehilangan waktu; seller kena imbas reputasi (E-03).

### E-03 · Auto-rating tanpa mandat, isinya bisa faktual salah · **MAJOR** · [ECO-003]
- **Bukti**: pasca job E-02, sistem mengirim rating **1.50/5.00** a.n. identitas buyer kami tanpa diminta, komentar "Deliverable tidak diterima" — faktual salah saat job `complete` (deliverable diterima & terverifikasi). Anehnya, 1.5 itu **tidak muncul** di feedback-list publik (kontradiksi "Rating Terkirim" vs ledger publik). Koreksi manual 4.5 kami justru tampil.
- **Dampak**: reputasi seller digerakkan otomasi yang menghukum seller atas bug funnel-nya sendiri; kontradiksi tampil-vs-terkirim menambah ketidakpercayaan.

### E-04 · Dokumentasi menyuruh format parameter yang justru gagal · **MAJOR** · [ECO-004]
- **Bukti eksperimen terkontrol**: `--service-params` teks natural (sesuai docs CLI: "natural language") → gagal (E-02); `--service-params` **JSON mentah** → sukses penuh end-to-end (bayar→deliverable→auto-complete→rating 5.0). Direplikasi konsisten di 5 task berikutnya.
- **Rekomendasi OKX**: dokumentasikan JSON; atau benar-benar petakan teks natural → body via `outputSchema` layanan (skemanya tersedia in-band!).

### E-05 · Auto-rating tak bisa dimatikan oleh pemilik identitas · minor (prinsip serius) · [ECO-005]
- **Bukti**: rating tetap terkirim meski `agent bypass off` (bypass:false terkonfirmasi), `config permissions --preset auto`, binding provider benar, daemon restart. Feedback publik seller 3→8 entri dalam satu sesi QA.
- **Dampak**: buyer tak punya kendali atas tindakan reputasional yang dilakukan atas namanya.

### E-06 · Nit dokumentasi/CLI ekosistem · nit
- Referensi CLI: `feedback-submit --score <0-100>` padahal CLI menuntut 0.00–5.00 (disimpan internal ×20).
- `job-provider bind-current` timeout konsisten saat `create-task` (warning di setiap pembuatan task).
- Riwayat wallet menampilkan transfer `0E-18 OKB` (kosmetik).

---

## 4. Peta bukti

| Artefak | Lokasi |
|---|---|
| Jurnal mentah kronologis | `BUG_JOURNAL.md` |
| Arsip request/respons per panggilan | `state/evidence/` (ribuan file, timestamp UTC) |
| Ledger pembayaran buyer | `state/ledger.csv` |
| Rekonsiliasi on-chain hari-2 | `state/reconciliation_d2.json` |
| Log desk berjalan | `state/desk_log.txt` |
| Verifikasi envelope (alat) | `agent/verify.mjs` + klon `vendor/quiver` |
| Deliverable task marketplace | `C:\Users\Tristan\.onchainos\deliverables\user\` |

## 5. Yang LOLOS uji (catatan adil — penting untuk laporan berimbang)

1. **Integritas matematis & kriptografis: sempurna sejauh ini.** 900+ envelope diverifikasi independen — contentHash cocok semua, selfChecks lolos semua, signature selalu recover ke signer terpublikasi, codeHash live == repo == `/build`, dan `reproduce()` byte-identik untuk engine deterministik yang diekspor. Tidak ada satu pun HASH-MISMATCH sepanjang sesi.
2. **Konsistensi harga & penerima: 100%.** 402 vs docs vs marketplace vs settle — tak pernah menyimpang sesen pun, di dua funnel.
3. **Kegagalan pra-engine tidak menagih** — konsisten di semua kasus 500 (sisi baiknya Q-09).
4. **Kejujuran epistemik produk**: updown-pulse menolak mengarang edge; observation vs proof dibedakan disiplin; disclosure `_entryDefaultedToMark`, `diffComplete`, `betaTier` validation record — kelas kejujuran yang jarang.
5. **Determinisme antar funnel**: perp-gate via marketplace vs via x402 langsung → jarak likuidasi identik (18.987%) pada leverage sama.
6. **Latensi**: median ~2s per panggilan berbayar penuh (bayar+replay) — layak untuk loop 15 menit; tidak ada insiden latensi ekstrem pasca Q-01.

## 6a. VERIFIKASI FIX (23 Jul ~02:30 UTC — build baru `q1-bce7e7bccb16ea1b`, commit `461d583` + `1770dde`)

Vendor men-deploy perbaikan; diverifikasi ulang **dari kursi buyer, jalur publik** (probe berbayar + saldo on-chain sebelum/sesudah). Klon repo di-pull: **buildId klon == `/build` baru** — rantai reproduktibilitas tetap utuh pasca-deploy.

| ID | Probe verifikasi | Hasil | Status |
|---|---|---|---|
| Q-02 | `.gitattributes` di repo + komentar penjelasan | ada, lengkap (LF utk semua source + binary exceptions) | ✅ FIXED |
| Q-03 | perp-gate tanpa margin/leverage | **400** `bad_input` (dulu 500), gratis | ✅ FIXED |
| Q-05 | header settle panggilan valid | `status:"settled"` + tx hash; kosakata baru eksplisit (`settled`/`not_charged`), "timeout" ambigu hilang | ✅ FIXED |
| Q-07 | macro-sentry | envelope **observation** (dulu proof), verifikasi lolos | ✅ FIXED |
| Q-09 | size-gate winProb=1.7; perp-gate DOGEMOON999 | tetap 200+envelope (error terverifikasi — desain yang bisa dibela) TAPI settle: `success:false, status:"not_charged", reason:"input rejected by engine — no settlement"` — dan memang **tidak menagih** | ✅ FIXED (kebijakan seragam + tereksplisitkan di header) |
| Q-11 | loop-digest chain xlayer | `ok:false` + **not_charged** (dulu tertagih 0.01/panggilan kosong) | ✅ FIXED |
| Q-12 | settle di-gate tx-hash (klaim commit: 68/818 ≈ 7% leak terkonfirmasi empiris oleh vendor — konvergen dgn estimasi buyer ~11% yang memuat noise atribusi) | label+tx per panggilan kini eksplisit; **rate leak baru diukur statistik di jendela hari-3** (§6 no. 1 tetap berlaku utk konfirmasi penuh) | 🟡 VERIFIED-MEKANISME, rate menunggu jendela ukur |
| Q-04 | commit menyebut "schema OR-constraints" | belum diprobe ulang | 🟡 belum diverifikasi |
| Q-08 | commit menyebut "protocol-pulse graceful DATA_UNAVAILABLE" | belum diprobe ulang (menunggu rotasi slot desk) | 🟡 belum diverifikasi |
| Q-06/Q-10 | drift docs paper | commit menyebut "paper/docs" diperbarui | 🟡 belum diverifikasi |

**Bukti uang baterai verifikasi**: saldo 18.660249 → 18.645249 = tepat 0.015 (2 panggilan valid: macro-sentry 0.005 + size-gate 0.01); 4 probe tak-valid/tak-tercakup = **0 tagihan**. Konsisten sempurna dengan kebijakan baru.

**Penyesuaian sisi buyer**: klien kami kini membaca `status` settle eksplisit untuk akuntansi (`quiver_client.py`); konstanta codeHash diperbarui. Restart desk direkomendasikan (tidak urgen) agar akuntansi `not_charged` aktif.

## 6. Langkah verifikasi lanjutan yang disarankan (di lingkungan pengembangan, bukan sesi ini)

1. **Q-12**: cocokkan log facilitator dengan event Transfer on-chain per txHash yang diklaim `PAYMENT-RESPONSE` — konfirmasi rate kebocoran & pemicunya (timeout threshold?).
2. **Q-01**: forensik log Railway jendela 05:30–06:20 UTC 21 Jul.
3. **E-03**: telusuri ke mana rating 1.5 "terkirim" sebenarnya pergi (state internal task vs ledger feedback publik).
4. Pantau scrub self-buy OKX terhadap 8 review "sentinel desk" + delta SOLD.
5. Setelah fix Q-03/Q-09: jalankan ulang 5 probe input nakal sebagai regression suite (payload persis ada di jurnal).
