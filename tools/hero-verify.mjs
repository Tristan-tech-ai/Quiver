// Verify the hero upgrades on live Railway: calldata SIMULATION + options greeks vs Deribit.
import fs from 'node:fs';
const T = fs.readFileSync(new URL('../.diag-token', import.meta.url), 'utf8').trim();
const B = 'https://quiver-production-c3a8.up.railway.app';
const scan = async (svc, params) => (await fetch(`${B}/diag/scan?token=${T}&svc=${svc}&${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(45000) })).json();

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const UNIROUTER = 'E592427A0AEce92De3Edee1F18E0157C05861564';
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';
const approveMax = '0x095ea7b3000000000000000000000000' + UNIROUTER + 'f'.repeat(64);
const transfer100 = '0xa9059cbb000000000000000000000000' + VITALIK.slice(2) + (100000000).toString(16).padStart(64, '0');

console.log('=== CALLDATA SIM: unlimited USDC approve to Uniswap (from vitalik) ===');
let r = await scan('calldata-x', { data: approveMax, to: USDC, from: VITALIK, chain: 'ethereum' });
console.log('verdict:', r.verdict, '| flags:', JSON.stringify((r.riskFlags || []).map((f) => f.flag)));
console.log('simulation:', JSON.stringify(r.simulation));

console.log('\n=== CALLDATA SIM: transfer 100 USDC from Binance (should show OUT) ===');
r = await scan('calldata-x', { data: transfer100, to: USDC, from: BINANCE, chain: 'ethereum' });
console.log('verdict:', r.verdict, '| plain:', r.plainEnglish);
console.log('assetChanges:', JSON.stringify(r.simulation?.assetChanges), '| reverted:', r.simulation?.wouldRevert);

console.log('\n=== OPTIONS delta validation vs Deribit own greeks ===');
// fetch a mid-expiry ATM-ish call ticker from Deribit and compare its delta to our Black-76
const book = await (await fetch(`${B}/diag/fetch?token=${T}&url=${encodeURIComponent('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option')}`)).json();
let arr; try { arr = JSON.parse(book.body).result; } catch { arr = []; }
const spot = Number(arr.find((x) => x.underlying_price)?.underlying_price);
// pick a call ~30-45 DTE near ATM
const cands = arr.filter((x) => /-(C)$/.test(x.instrument_name) && x.mark_iv);
console.log('spot:', spot, 'sampled', cands.length, 'calls; validating a few near-ATM:');
const { black76 } = await import('../src/engine/black76.js');
const parse = (n) => { const m = n.match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-C$/); if (!m) return null; const mo = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 }; return { exp: Date.UTC(2000 + +m[3], mo[m[2]], +m[1], 8), K: +m[4] }; };
const now = Date.now();
for (const c of cands.filter((c) => { const p = parse(c.instrument_name); return p && p.exp - now > 20 * 864e5 && p.exp - now < 50 * 864e5 && Math.abs(p.K - spot) < spot * 0.15; }).slice(0, 4)) {
  const p = parse(c.instrument_name); const T2 = (p.exp - now) / (365 * 864e5);
  const tk = await (await fetch(`${B}/diag/fetch?token=${T}&url=${encodeURIComponent('https://www.deribit.com/api/v2/public/ticker?instrument_name=' + c.instrument_name)}`)).json();
  let deribitDelta = null, ivPct = c.mark_iv; try { const tr = JSON.parse(tk.body).result; deribitDelta = tr.greeks?.delta; ivPct = tr.mark_iv; } catch {}
  const mine = black76(spot, p.K, T2, ivPct / 100, 'call');
  console.log(`  ${c.instrument_name}: mine=${mine.delta.toFixed(4)} deribit=${deribitDelta} diff=${deribitDelta != null ? (mine.delta - deribitDelta).toFixed(4) : 'n/a'}`);
}
