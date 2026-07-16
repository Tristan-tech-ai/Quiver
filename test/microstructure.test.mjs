// Locks the tape-microstructure estimators (Kyle's λ, Amihud, VPIN) against known-answer synthetic tapes,
// and enforces the honesty gates: too-thin or price-flat tapes must return null, never a false number.
// λ and Amihud are estimated on equal-count PERIOD blocks (dust-immune, sparse-tape-robust) — the synthetic
// tapes below create genuine block-level correlation between net order flow and the price change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { microstructure } from '../src/engine/tapePulse.js';

// A tape with runs of buys then sells (sin pattern): every BUY lifts price by +step, every SELL drops it.
// Across a block the net order flow and the block's price change therefore move together by construction,
// so block-based Kyle's λ must be positive with near-perfect fit and sign-agreement.
function impactTape(n = 200, step = 0.002, vol = 5000) {
  const trades = [];
  let p = 1.0, t = 0;
  for (let i = 0; i < n; i++) {
    const buy = Math.sin(i / 7) >= 0;              // runs of buys / sells → blocks vary in net imbalance
    p = p * (1 + (buy ? step : -step));
    trades.push({ type: buy ? 'buy' : 'sell', vol, price: p, time: t += 1000 });
  }
  return trades;
}

test('Kyle λ is positive with high sign-agreement when net flow drives the block price change', () => {
  const m = microstructure(impactTape());
  assert.ok(m.kyleLambda, 'λ estimated on a rich tape');
  assert.ok(m.kyleLambda.priceImpactBpsPer10kUsd > 0, 'positive price impact');
  assert.ok(m.kyleLambda.signAgreement >= 0.9, `flow explains direction (got ${m.kyleLambda.signAgreement})`);
  assert.ok(m.kyleLambda.rSquared >= 0.8, `tight block-level fit (got ${m.kyleLambda.rSquared})`);
  assert.ok(m.kyleLambda.blocks >= 8, 'enough blocks to regress');
});

test('VPIN → 1 for a fully one-sided (all-buy) tape, → ~0 for perfectly alternating equal size', () => {
  const allBuy = Array.from({ length: 80 }, (_, i) => ({ type: 'buy', vol: 1000, price: 1 + i * 1e-4, time: i * 1000 }));
  const mBuy = microstructure(allBuy);
  assert.ok(mBuy.vpin && Math.abs(mBuy.vpin.value - 1) < 1e-6, `all-buy → VPIN 1 (got ${mBuy.vpin?.value})`);

  const alt = Array.from({ length: 80 }, (_, i) => ({ type: i % 2 ? 'sell' : 'buy', vol: 1000, price: 1 + i * 1e-4, time: i * 1000 }));
  const mAlt = microstructure(alt);
  assert.ok(mAlt.vpin && mAlt.vpin.value <= 0.1, `balanced → low VPIN (got ${mAlt.vpin?.value})`);
});

test('Amihud rises when the same dollar flow moves price more (thinner liquidity)', () => {
  const big = microstructure(impactTape(200, 0.004, 5000));   // 4× the price step per trade
  const small = microstructure(impactTape(200, 0.001, 5000)); // gentler moves, same size
  assert.ok(big.amihud.pctMovePer1kUsd > small.amihud.pctMovePer1kUsd, 'bigger move per $ ⇒ higher Amihud');
});

test('Amihud is dust-immune: a few sub-cent trades do not blow up the estimate', () => {
  // A clean ~$5k tape, then inject dust trades ($0.0001) with price jitter — a per-trade ratio would explode.
  const trades = impactTape(200, 0.002, 5000);
  for (let i = 20; i < 200; i += 40) trades.splice(i, 0, { type: 'buy', vol: 0.0001, price: trades[i].price * 1.02, time: trades[i].time + 1 });
  const m = microstructure(trades);
  assert.ok(m.amihud && m.amihud.pctMovePer1kUsd < 5, `dust does not explode Amihud (got ${m.amihud?.pctMovePer1kUsd} %/$1k)`);
});

test('tape density is surfaced (median gap + span) so sampled feeds are visible', () => {
  const m = microstructure(impactTape(120));
  assert.ok(m.tape && typeof m.tape.medianGapSeconds === 'number', 'median inter-trade gap reported');
  assert.ok(typeof m.tape.spanHours === 'number', 'span reported');
});

test('honesty gate: a too-thin tape returns all-null (no false precision)', () => {
  const m = microstructure(impactTape(10)); // 1 block, < 8
  assert.equal(m.kyleLambda, null, 'λ null under 8 blocks');
  assert.equal(m.amihud, null, 'Amihud null under 8 blocks');
  assert.equal(m.vpin, null, 'VPIN null under 50 trades');
});

test('honesty gate: a price-flat tape yields no λ (zero return variance ⇒ null, not 0)', () => {
  const flat = Array.from({ length: 200 }, (_, i) => ({ type: i % 2 ? 'sell' : 'buy', vol: 1000, price: 2.5, time: i * 1000 }));
  const m = microstructure(flat);
  assert.equal(m.kyleLambda, null, 'no price variation ⇒ λ null');
  assert.ok(m.amihud && m.amihud.pctMovePer1kUsd === 0, 'flat price ⇒ Amihud exactly 0');
});
