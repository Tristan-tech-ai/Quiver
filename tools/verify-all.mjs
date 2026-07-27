// Verify every service on the live Railway deploy via the gated /diag/scan tester.
import fs from 'node:fs';
const BASE = 'https://quiver-production-c3a8.up.railway.app/diag/scan';
const TOKEN = fs.readFileSync(new URL('../.diag-token', import.meta.url), 'utf8').trim();

const CASES = [
  ['tape-pulse', { chain: 'solana', address: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump' }, (d) => d.verdict + ' imbalance=' + (d.read?.buyImbalance)],
  ['chart-press', { chain: 'solana', address: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump' }, (d) => (d.facts ? d.facts.symbol + ' ' + d.facts.change24hPct + '% png=' + Math.round((d.imageBase64 || '').length * 0.75) + 'B url=' + d.hostedUrl : d.verdict)],
  ['options-desk', { currency: 'BTC' }, (d) => (d.headline ? 'spot=' + d.spot + ' frontIV=' + d.headline.frontAtmIvPct + ' maxPain=' + d.headline.frontMaxPain + ' PCR=' + d.headline.putCallOiRatioAll + ' regime=' + d.headline.volRegime : d.verdict)],
  ['options-desk-ETH', { currency: 'ETH', svc: 'options-desk' }, (d) => (d.headline ? 'ETH spot=' + d.spot + ' IV=' + d.headline.frontAtmIvPct : d.verdict)],
  ['poly-fill', { market: 'bitcoin', usd: 500, side: 'YES' }, (d) => (d.fill ? d.verdict + ' avg=' + d.fill.avgPriceCents + 'c slip=' + d.fill.slippageVsMidPct + '% q="' + (d.question || '').slice(0, 40) + '"' : d.verdict + ' ' + (d.note || ''))],
  ['poly-desk', { wallet: '0x0000000000000000000000000000000000000001' }, (d) => d.verdict + ' ' + (d.summary ? JSON.stringify(d.summary) : (d.note || ''))],
  ['protocol-pulse', { protocol: 'aave' }, (d) => (d.grade ? d.protocol + ' grade=' + d.grade + ' tvl=' + (d.tvl?.currentUsd) + ' 30d=' + d.tvl?.change30dPct + '% hacks=' + d.incidents?.count : d.verdict)],
  ['protocol-pulse-lido', { protocol: 'lido', svc: 'protocol-pulse' }, (d) => (d.grade ? 'lido grade=' + d.grade + ' tvl=' + d.tvl?.currentUsd : d.verdict)],
  ['macro-sentry', { hours: 240 }, (d) => d.verdict + ' events=' + (d.events?.length) + ' next=' + (d.nextEvent?.kind)],
  ['updown-pulse', { coin: 'BTC' }, (d) => d.verdict + ' ' + (d.window ? 'left=' + d.window.secondsLeft + 's implied=' + JSON.stringify(d.marketImplied) + ' edge=' + d.model?.edgeUpPoints : (d.note || ''))],
  ['calldata-x', { data: '0x095ea7b3000000000000000000000000e592427a0aece92de3edee1f18e0157c05861564ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' }, (d) => d.verdict + ' | ' + (d.plainEnglish || d.note || '').slice(0, 60)],
  ['loop-digest', { chain: 'solana', wallet: '9RTez1Ytfqb4EQrnd26oBNdQeWnRiwPkJdwDFpHFwDUj' }, (d) => d.verdict || ('baseline=' + d.baseline + ' cursor=' + (d.cursor ? 'ok' : 'none') + ' tracked=' + d.positionsTracked)],
];

for (const [label, params, fmt] of CASES) {
  const svc = params.svc || label.replace(/-(ETH|lido)$/, '');
  const q = new URLSearchParams({ token: TOKEN, svc, ...Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'svc')) });
  try {
    const r = await fetch(`${BASE}?${q}`, { signal: AbortSignal.timeout(45000) });
    const d = await r.json();
    const ok = !d.error && d.verdict !== undefined || d.facts || d.grade || d.headline || d.fill || d.summary || d.read;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label.padEnd(20)} ${r.status}  ${(() => { try { return fmt(d); } catch { return JSON.stringify(d).slice(0, 120); } })()}`);
  } catch (e) { console.log(`ERR  ${label.padEnd(20)} ${e.message}`); }
}
