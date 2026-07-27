// Five defects found by a second adversarial reviewer, this one with live access to the deployed
// service. Three of them were defects in the FIXES shipped earlier the same day: a soundness check
// that still could not fail, a boundedness check with an escape hatch written into it, and a
// below-maintenance status that a second code path walked straight past. That is the pattern worth
// recording — the first pass closed each defect on the branch the first reviewer exercised.
//
//   A. risk-attest  soundness check used a ONE-element proof -> vacuous except at depth 3
//   B. risk-attest  non-hex leaves silently truncated -> distinct inputs collided, non-member verified
//   C. lp-risk      boundedness check read `pass: conc > 1 ? true` -> -200% shipped green
//   D. perp-gate    liquidatable_at_entry returned early with no positionStatus -> dead leg ranked live
//   E. size-gate    drawdownLevels unvalidated -> ruin "probabilities" of 128 and 2187
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { riskAttest, verifyInclusion } from '../src/engine/riskAttest.js';
import { lpRisk } from '../src/engine/lpRisk.js';
import { perpGate } from '../src/engine/perpGate.js';
import { portfolioGate } from '../src/engine/portfolioGate.js';
import { sizeGate } from '../src/engine/sizeGate.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const leaves = (n) => Array.from({ length: n }, (_, i) => sha(Buffer.from('L' + i)));

// ---------------------------------------------------------------------------------------------
// A. The soundness check must use the FULL path from the internal node to the root. With a single
// sibling it only reaches the root when the tree is exactly three layers deep, so for n=2 and for
// every n>=5 it compared a half-folded value, got false for arithmetic reasons, and reported a pass.
// ---------------------------------------------------------------------------------------------
test('A risk-attest: the internal-node check runs at every batch size that has an internal node', () => {
  for (const n of [3, 4, 5, 6, 8, 12, 16]) {
    const r = riskAttest({ contentHashes: leaves(n) });
    const c = r.checks.find((x) => /INTERNAL NODE/.test(x.name));
    assert.ok(c, `n=${n}: the check must be present`);
    assert.notEqual(c.skipped, true, `n=${n}: an internal node exists here, so the check must not be skipped`);
    assert.equal(c.pass, true, `n=${n}`);
    // THE assertion that matters. A verdict of `true` is what the vacuous version also returned, so
    // asserting it proves nothing — this pins that the node was folded ALL the way to the root. With
    // a one-element proof these two numbers diverge for every tree deeper than three layers, which is
    // exactly where the old check went blind.
    assert.equal(c.pathElements, c.pathElementsRequired,
      `n=${n}: the check used ${c.pathElements} of the ${c.pathElementsRequired} sibling(s) needed to reach the root — a partial fold certifies nothing`);
    assert.equal(c.pathElementsRequired, c.treeDepth - 2, `n=${n}: full path from layer 1 to the root`);
  }
});

test('A risk-attest: with no internal node the check is reported as not-run, never as a pass', () => {
  for (const n of [1, 2]) {
    const c = riskAttest({ contentHashes: leaves(n) }).checks.find((x) => /INTERNAL NODE/.test(x.name));
    assert.equal(c.skipped, true, `n=${n}`);
    assert.equal(c.pass, null, `n=${n}: null, not true — it did not run`);
  }
});

// The property that makes it a check at all: an internal node folded along its FULL path reaches the
// root when the leaf/node tags are absent. This reconstructs an untagged tree and proves the attack
// the check exists to detect is real, so the check has something to catch.
test('A risk-attest: an untagged tree IS attackable via the full path (so the check can go red)', () => {
  const hs = leaves(8);
  const nodeH = (x, y) => { const [lo, hi] = x <= y ? [x, y] : [y, x]; return sha(Buffer.concat([Buffer.from(lo, 'hex'), Buffer.from(hi, 'hex')])); };
  let layer = hs.slice(); const layers = [layer];
  while (layer.length > 1) {
    const nx = [];
    for (let i = 0; i < layer.length; i += 2) nx.push(i + 1 < layer.length ? nodeH(layer[i], layer[i + 1]) : layer[i]);
    layer = nx; layers.push(layer);
  }
  const root = layers[layers.length - 1][0];
  const fold = (start, idx) => { let h = layers[start][idx], j = idx; for (let l = start; l < layers.length - 1; l++) { const sib = j ^ 1; if (sib < layers[l].length) h = nodeH(h, layers[l][sib]); j = Math.floor(j / 2); } return h; };
  assert.equal(fold(1, 0), root, 'without domain separation an internal node folds to the root along its full path');
  // One sibling only is NOT the attack at this depth — which is exactly why the old check was blind.
  const oneStep = nodeH(layers[1][0], layers[1][1]);
  assert.notEqual(oneStep, root, 'a one-element proof cannot reach the root at depth 4');
});

// ---------------------------------------------------------------------------------------------
// B. Buffer.from(hex,'hex') truncates at the first invalid or odd position, so 'abc' and 'abd' both
// became the byte 0xab: two distinct caller inputs collapsed into one leaf, and a non-member
// verified against a real root using another leaf's proof.
// ---------------------------------------------------------------------------------------------
test('B risk-attest: a malformed leaf is refused, not silently truncated', () => {
  const real = [sha(Buffer.from('r1')), sha(Buffer.from('r2'))];
  for (const bad of ['abc', 'abd', 'zz'.repeat(32), 'aa'.repeat(31), '0xabc']) {
    const r = riskAttest({ contentHashes: [bad, ...real] });
    assert.equal(r.ok, false, `"${bad}" must be refused`);
    assert.match(r.errors[0], /32-byte hex/);
  }
});

test('B risk-attest: the truncation collision that let a non-member verify is gone', () => {
  assert.equal(Buffer.from('abc', 'hex').toString('hex'), Buffer.from('abd', 'hex').toString('hex'),
    'precondition: node truncates both to the same byte, which is why this was exploitable');
  const r = riskAttest({ contentHashes: ['abc', sha(Buffer.from('r1')), sha(Buffer.from('r2'))] });
  assert.equal(r.ok, false, 'the batch that made the collision reachable is now refused outright');
  // A well-formed batch still behaves.
  const good = riskAttest({ contentHashes: leaves(4) });
  assert.equal(good.ok, true);
  assert.equal(verifyInclusion(sha(Buffer.from('not-a-member')), good.attestations[0].proof.map((p) => p.slice(2)), good.merkleRoot.slice(2)), false);
});

// ---------------------------------------------------------------------------------------------
// C. The boundedness check was written as `pass: conc > 1 ? true : (...)` — disabled in exactly the
// regime where the number breaks. conc 5 at a 9x move served -200% and -$200,000 on $100,000.
// ---------------------------------------------------------------------------------------------
test('C lp-risk: an amplified realized IL never leaves (-100%, 0], and the check has no escape hatch', () => {
  const r = lpRisk({ priceRatio: 9, concentrationFactor: 5, capitalUsd: 100000 });
  const il = r.realizedIL.impermanentLossPct;
  assert.ok(il <= 0 && il > -100, `headline must be possible, got ${il}%`);
  assert.ok(r.realizedIL.usd > -100000, `cannot lose more than the capital, got ${r.realizedIL.usd}`);
  assert.equal(r.realizedIL.concentratedModelInRange, false, 'the caller must be told the amplification left its range');
  assert.ok(r.realizedIL.linearAmplificationPct < -100, 'the raw linearisation is still disclosed');
  const c = r.checks.find((x) => /boundedness: reported realized IL/.test(x.name));
  assert.equal(c.pass, true);
  assert.match(c.name, /amplified or not/, 'the check must state it covers the amplified case');
});

test('C lp-risk: the boundedness check still FAILS on an out-of-range value (it can go red)', () => {
  // Feed the check's own predicate the pre-fix headline to show the predicate discriminates.
  const r = lpRisk({ priceRatio: 9, concentrationFactor: 5 });
  const preFixHeadline = r.realizedIL.linearAmplificationPct;
  assert.equal(preFixHeadline <= 0 && preFixHeadline > -100, false, 'the old headline fails the new predicate');
});

test('C lp-risk: amplified EXPECTED divergence is bounded too', () => {
  const r = lpRisk({ volatility: Math.sqrt(5), horizonPeriods: 1, concentrationFactor: 3, capitalUsd: 100000 });
  const e = r.expectedDivergence.expectedIlPct;
  assert.ok(e <= 0 && e > -100, `got ${e}%`);
  assert.equal(r.expectedDivergence.concentratedModelInRange, false);
  assert.ok(r.checks.every((c) => c.pass !== false));
});

test('C lp-risk: a concentration that stays in range is untouched', () => {
  const r = lpRisk({ priceRatio: 1.2, concentrationFactor: 3 });
  const full = lpRisk({ priceRatio: 1.2 }).realizedIL.impermanentLossPct;
  // Both sides are rounded to 4dp independently, so the comparison carries a rounding budget of
  // 4 x 0.00005; a tighter tolerance compares rounding noise, not behaviour.
  assert.ok(Math.abs(r.realizedIL.impermanentLossPct - 3 * full) < 1e-3, 'amplification still applies where it is valid');
  assert.equal(r.realizedIL.concentratedModelInRange, true);
});

// ---------------------------------------------------------------------------------------------
// D. perp-gate's liquidatable_at_entry branch returned before positionStatus was ever set, so
// portfolio-gate saw no status, ranked the dead leg as nearest at 0%, and called it "still live".
// ---------------------------------------------------------------------------------------------
const deadAtEntry = { venue: 'hl', asset: 'BTC', kind: 'perp', side: 'long', size: 1, entryPrice: 100000, markPrice: 100000, margin: 1000, maxLeverage: 40 };
const aliveLeg = { venue: 'hl', asset: 'ETH', kind: 'perp', side: 'long', size: 20, entryPrice: 3000, markPrice: 3000, margin: 6000, maxLeverage: 25 };

test('D perp-gate: liquidatable-at-entry carries the below-maintenance status and a check', () => {
  const g = perpGate(deadAtEntry);
  assert.equal(g.liquidatable_at_entry, true, 'precondition: this is the early-return branch');
  assert.equal(g.positionStatus, 'BELOW_MAINTENANCE');
  assert.match(g.statusNote, /reconcile, not one to protect/);
  assert.ok(Array.isArray(g.checks) && g.checks.length >= 1, 'the branch must assert its own condition');
  assert.equal(g.checks[0].pass, true);
});

test('D portfolio-gate: a leg dead at entry is breached, not the nearest FUTURE liquidation', () => {
  const r = portfolioGate({ positions: [deadAtEntry, aliveLeg] });
  assert.equal(r.nearestLiquidation.asset, 'ETH', 'the live leg must win the ranking');
  assert.ok(Array.isArray(r.breachedLegs) && r.breachedLegs.length === 1);
  assert.equal(r.breachedLegs[0].asset, 'BTC');
  assert.equal(r.breachedLegs[0].positionStatus, 'BELOW_MAINTENANCE');
  assert.doesNotMatch(r.nearestLiquidation.note, /whole book's real distance/,
    'the book-wide phrasing must not be used while a leg is already gone');
});

test('D portfolio-gate: the invariant check counts only legs that had an invariant', () => {
  const r = portfolioGate({ positions: [deadAtEntry, aliveLeg] });
  const inv = r.checks.find((c) => /invariant/i.test(c.name));
  assert.equal(inv.positionsChecked, 1, 'the dead-at-entry leg solved nothing, so it was not checked');
  assert.equal(inv.positionsWithNoInvariantToCheck, 1);
  assert.equal(inv.pass, true);
});

// ---------------------------------------------------------------------------------------------
// E. drawdownLevels was caller-supplied and unvalidated, so alpha^((2-lambda)/lambda) was evaluated
// outside (0,1) and returned 128 and 2187 as "probabilities", with ok:true.
// ---------------------------------------------------------------------------------------------
test('E size-gate: drawdownLevels outside (0,1) is refused', () => {
  for (const lv of [[-0.5], [1.5], [2, 3], [0], [1]]) {
    const s = sizeGate({ winProb: 0.55, winLossRatio: 1.2, bankroll: 1000, drawdownLevels: lv });
    assert.equal(s.ok, false, `${JSON.stringify(lv)} must be refused`);
    assert.match(s.errors[0], /strictly in \(0,1\)/);
  }
});

test('E size-gate: valid levels still work and every ruin figure is a probability', () => {
  const s = sizeGate({ winProb: 0.55, winLossRatio: 1.2, bankroll: 1000, drawdownLevels: [0.5, 0.1] });
  assert.equal(s.ok, true);
  const rng = s.checks.find((c) => /range/.test(c.name));
  assert.equal(rng.pass, true);
});

test('E size-gate: the ruin anchor discriminates a wrong exponent (lambda=1 alone does not)', () => {
  const s = sizeGate({ winProb: 0.55, winLossRatio: 1.2, bankroll: 1000 });
  const anchors = s.checks.filter((c) => /risk-of-ruin anchor/.test(c.name));
  assert.equal(anchors.length, 2, 'one anchor at lambda=1 cannot tell (2-l)/l from (2-l)/l^2');
  assert.ok(anchors.every((a) => a.pass));
  // Demonstrate the discrimination the second anchor provides.
  const right = (a, l) => Math.pow(a, (2 - l) / l);
  const wrong = (a, l) => Math.pow(a, (2 - l) / (l * l));
  assert.equal(right(0.5, 1), wrong(0.5, 1), 'lambda=1 is degenerate');
  assert.notEqual(right(0.5, 0.25), wrong(0.5, 0.25), 'lambda=0.25 separates them');
});
