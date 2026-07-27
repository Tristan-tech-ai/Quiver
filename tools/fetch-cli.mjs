// postinstall: on Linux (Railway build), fetch the onchainos CLI binary used by the
// production data adapter. Verifies SHA256 against the release checksums. No-op on Windows/macOS
// (dev uses the locally installed binary via ONCHAINOS_BIN).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const TAG = process.env.ONCHAINOS_TAG || 'v4.2.2';
const ASSET = 'onchainos-x86_64-unknown-linux-gnu';
const REPO = 'okx/onchainos-skills';

if (process.platform !== 'linux') {
  console.log('[fetch-cli] non-linux platform, skipping (dev uses local onchainos)');
  process.exit(0);
}

const outDir = path.resolve('bin');
const outBin = path.join(outDir, 'onchainos');

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

try {
  fs.mkdirSync(outDir, { recursive: true });
  const checks = (await download(`https://github.com/${REPO}/releases/download/${TAG}/checksums.txt`)).toString('utf8');
  const line = checks.split(/\r?\n/).find((l) => l.includes(ASSET));
  if (!line) throw new Error(`no checksum entry for ${ASSET}`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();

  const bin = await download(`https://github.com/${REPO}/releases/download/${TAG}/${ASSET}`);
  const actual = crypto.createHash('sha256').update(bin).digest('hex');
  if (actual !== expected) throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);

  fs.writeFileSync(outBin, bin);
  fs.chmodSync(outBin, 0o755);
  console.log(`[fetch-cli] installed ${ASSET} (${bin.length} bytes, sha256 ok) -> ${outBin}`);
} catch (e) {
  // Exiting non-zero here failed `npm ci` itself, and `npm ci` is step one of the reproduction recipe
  // this project publishes — so a reader on Linux with no route to GitHub releases, or hitting the
  // known checksum drift between CLI releases, never reached `npm test` at all. That also made the
  // claim "the suite requires no network access" false in practice: true of the tests, and not of the
  // install that precedes them.
  //
  // The binary is needed only by the OKX-backed LIVE adapters. Without it the deterministic engines,
  // the whole test suite, and every proof in the documentation still work, and the live services
  // degrade to the DATA_UNAVAILABLE they already disclose and do not charge for — a visible, honest
  // failure rather than a broken build. So this warns loudly and lets the install finish.
  console.error('');
  console.error('  [fetch-cli] could not fetch the onchainos CLI:', e.message);
  console.error('  [fetch-cli] INSTALL CONTINUES. This binary is used only by the OKX-backed live');
  console.error('  [fetch-cli] adapters. Unaffected: `npm test`, every deterministic engine, and every');
  console.error('  [fetch-cli] proof in the documentation — none of which touch the network.');
  console.error('  [fetch-cli] Affected: live OKX reads, which will answer DATA_UNAVAILABLE (and free).');
  console.error('  [fetch-cli] To retry: npm run fetch-cli');
  console.error('');
}
