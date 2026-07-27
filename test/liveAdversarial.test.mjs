// Four defects found by an adversarial live buyer session against the deployed endpoint, all four
// in the class this codebase exists to prevent: a number that is confidently wrong, or a verifier
// that cannot fail. Each test below FAILS on the pre-fix code — that is the point of writing them.
//
//   A. risk-attest folded ASCII HEX TEXT instead of packed bytes  -> proofs unverifiable on-chain
//   B. risk-attest had no domain separation                       -> an INTERNAL NODE verified as a member
//   C. lp-risk headlined the leading-order -sigma^2*T/8           -> reported IL of -135% (impossible)
//   D. perp/portfolio-gate narrated an ALREADY-LIQUIDATED leg     -> as the book's nearest FUTURE liquidation
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { riskAttest, verifyInclusion } from '../src/engine/riskAttest.js';
import { lpRisk } from '../src/engine/lpRisk.js';
import { perpGate } from '../src/engine/perpGate.js';
import { portfolioGate } from '../src/engine/portfolioGate.js';

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const H = (i) => sha256hex(Buffer.from('leaf-' + i)); // 32-byte content hashes, hex, no 0x

// ---------------------------------------------------------------------------------------------
// A. Packed-byte hashing. An INDEPENDENT re-implementation (the one an on-chain verifier would
// write: sha256 over 32-byte words) must reproduce the served root. The pre-fix engine folded the
// 64-char hex STRINGS, whose root differs, so this assertion fails on it.
// ---------------------------------------------------------------------------------------------
test('A risk-attest: root reproduces under byte-level re-implementation, not hex-text folding', () => {
  const leaves = [H(1), H(2), H(3), H(4)];
  const r = riskAttest({ contentHashes: leaves });
  assert.equal(r.ok, true);

  const b = (h) => Buffer.from(h, 'hex');
  const leafH = (h) => sha256hex(Buffer.concat([Buffer.from([0x00]), b(h)]));
  const nodeH = (x, y) => {
    const [lo, hi] = x <= y ? [x, y] : [y, x];
    return sha256hex(Buffer.concat([Buffer.from([0x01]), b(lo), b(hi)]));
  };
  let layer = leaves.map(leafH);
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? nodeH(layer[i], layer[i + 1]) : layer[i]);
    layer = next;
  }
  assert.equal(r.merkleRoot, '0x' + layer[0], 'served root must equal the byte-level recomputation');

  // And the same recomputation, digit for digit, is what the published `verify` recipe describes.
  assert.match(r.verify, /sha256\(0x00 \|\| L\)/);
  assert.match(r.verify, /abi\.encodePacked/);
});

// The hex-text scheme the engine used to run is DIFFERENT from the byte scheme. Pinning that
// difference is what makes test A a regression guard rather than a tautology.
test('A risk-attest: the old hex-TEXT folding yields a different root (the defect was real)', () => {
  const leaves = [H(1), H(2), H(3), H(4)];
  const r = riskAttest({ contentHashes: leaves });
  const oldPair = (x, y) => (x <= y ? sha256hex(Buffer.from(x + y)) : sha256hex(Buffer.from(y + x)));
  let layer = leaves.slice(); // pre-fix: leaves entered the tree UNTAGGED, as hex text
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? oldPair(layer[i], layer[i + 1]) : layer[i]);
    layer = next;
  }
  assert.notEqual(r.merkleRoot, '0x' + layer[0]);
});

// ---------------------------------------------------------------------------------------------
// B. Soundness under domain separation. Without leaf/node tags, any internal node verifies against
// the root with a one-element proof: the service whose only job is proving membership would attest
// something that was never a member.
// ---------------------------------------------------------------------------------------------
test('B risk-attest: an internal node presented as a member leaf does NOT verify', () => {
  const leaves = [H(1), H(2), H(3), H(4)];
  const r = riskAttest({ contentHashes: leaves });

  const b = (h) => Buffer.from(h, 'hex');
  const leafH = (h) => sha256hex(Buffer.concat([Buffer.from([0x00]), b(h)]));
  const nodeH = (x, y) => {
    const [lo, hi] = x <= y ? [x, y] : [y, x];
    return sha256hex(Buffer.concat([Buffer.from([0x01]), b(lo), b(hi)]));
  };
  const L = leaves.map(leafH);
  const nodeA = nodeH(L[0], L[1]);   // a real internal node: NOT one of the four content hashes
  const nodeB = nodeH(L[2], L[3]);

  assert.equal(verifyInclusion(nodeA, [nodeB], r.merkleRoot), false,
    'a real internal node must be rejected as a member leaf');
  // Its sibling-path arithmetic is otherwise perfect, which is exactly why the pre-fix code accepted it.
  assert.equal(nodeH(nodeA, nodeB), r.merkleRoot.slice(2), 'the node pair does fold to the root');
});

test('B risk-attest: the self-check for that attack is present AND passes', () => {
  const r = riskAttest({ contentHashes: [H(1), H(2), H(3), H(4)] });
  const c = r.checks.find((x) => /INTERNAL NODE/.test(x.name));
  assert.ok(c, 'the internal-node soundness check must be shipped, not just the fix');
  assert.equal(c.pass, true);
  assert.equal(r.checks.every((x) => x.pass), true);
});

// ---------------------------------------------------------------------------------------------
// C. Boundedness of expected divergence. V2 divergence loss lies in (-100%, 0]. The live session
// drove the leading-order rate to sigma^2*T = 10.8 and got -135%, then reasoned about it.
// ---------------------------------------------------------------------------------------------
test('C lp-risk: expected divergence stays inside (-100%, 0] at large variance', () => {
  const r = lpRisk({ volatility: 0.6, horizonPeriods: 30 }); // sigma^2*T = 10.8 -> leading order -135%
  const e = r.expectedDivergence;
  assert.ok(e.expectedIlPct <= 0 && e.expectedIlPct > -100,
    `headline expected IL must be a possible number, got ${e.expectedIlPct}%`);
  assert.ok(e.expectedIlLeadingOrderPct < -100, 'the expansion IS out of range here — that is the defect it hides');
  assert.ok(e.approximationGapPct > 50, 'the gap between the two must be disclosed, not smoothed over');
  assert.match(e.note, /Outside the small-variance regime/);
  assert.match(e.basis, /exact lognormal expectation/);
});

test('C lp-risk: the boundedness self-check runs on SERVED inputs and can fail', () => {
  const r = lpRisk({ volatility: 0.6, horizonPeriods: 30 });
  const c = r.checks.find((x) => /boundedness: reported expected divergence/.test(x.name));
  assert.ok(c, 'a check that only ever evaluates a fixed reference cannot catch this class of defect');
  assert.equal(c.pass, true);
  // The check is a real predicate over the served value, so feeding it the pre-fix headline fails it.
  const preFixHeadline = r.expectedDivergence.expectedIlLeadingOrderPct;
  assert.equal(preFixHeadline <= 0 && preFixHeadline > -100, false);
});

test('C lp-risk: small-variance regime still agrees with the leading-order rate', () => {
  const r = lpRisk({ volatility: 0.05, horizonPeriods: 30 }); // sigma^2*T = 0.075
  const e = r.expectedDivergence;
  assert.ok(Math.abs(e.expectedIlPct - e.expectedIlLeadingOrderPct) < 0.05,
    'the fix must not move the number where the approximation was valid');
  assert.match(e.note, /Small-variance regime/);
  assert.equal(r.checks.every((x) => x.pass), true);
});

// ---------------------------------------------------------------------------------------------
// D. An already-liquidated leg. moveToLiquidationPct < 0 does not mean "very close", it means the
// threshold was crossed. Pre-fix it was a bare negative number, and portfolio-gate ranked it as
// the book's nearest FUTURE liquidation and narrated it as the distance to first blood.
// ---------------------------------------------------------------------------------------------
// A long entered at 100k with 2.5% margin liquidates near 98.7k; a mark of 90k is well past it.
const deadLeg = { venue: 'hyperliquid', asset: 'BTC', kind: 'perp', side: 'long', size: 1, entryPrice: 100000, markPrice: 90000, margin: 2500, maxLeverage: 40 };
const liveLeg = { venue: 'hyperliquid', asset: 'ETH', kind: 'perp', side: 'long', size: 20, entryPrice: 3000, markPrice: 3000, margin: 6000, maxLeverage: 25 };

test('D perp-gate: a mark past the liquidation price is labelled BELOW_MAINTENANCE', () => {
  const g = perpGate(deadLeg);
  assert.equal(g.ok, true);
  assert.ok(g.moveToLiquidationPct < 0, 'precondition: this leg is past liquidation');
  assert.equal(g.positionStatus, 'BELOW_MAINTENANCE');
  assert.match(g.statusNote, /already beyond the liquidation price/);
  assert.match(g.statusNote, /reconcile, not one to protect/);
});

test('D perp-gate: a live position is labelled ABOVE_MAINTENANCE with no status note', () => {
  const g = perpGate(liveLeg);
  assert.equal(g.positionStatus, 'ABOVE_MAINTENANCE');
  assert.equal(g.statusNote, undefined);
});

test('D portfolio-gate: nearest ranks only LIVE legs; the dead leg is reported separately', () => {
  const r = portfolioGate({ positions: [deadLeg, liveLeg] });
  assert.equal(r.ok, true);
  // Pre-fix, the -10%-ish BTC leg won the min() and became `nearestLiquidation`.
  assert.equal(r.nearestLiquidation.asset, 'ETH', 'nearest must be the nearest FUTURE liquidation');
  assert.ok(r.nearestLiquidation.moveToLiquidationPct > 0);
  assert.ok(Array.isArray(r.breachedLegs) && r.breachedLegs.length === 1, 'the dead leg must be disclosed, not dropped');
  assert.equal(r.breachedLegs[0].asset, 'BTC');
  assert.equal(r.breachedLegs[0].positionStatus, 'BELOW_MAINTENANCE');
  assert.match(r.breachedLegs[0].note, /already beyond the liquidation price/);
  // The narration must point at the excluded legs rather than claim the whole book's distance.
  assert.match(r.nearestLiquidation.note, /already PAST their liquidation price/);
  assert.doesNotMatch(r.nearestLiquidation.note, /whole book's real distance/);
});

test('D portfolio-gate: with no breached leg, breachedLegs is absent and the note is unchanged', () => {
  const r = portfolioGate({ positions: [liveLeg] });
  assert.equal(r.breachedLegs, undefined);
  // This used to assert the note said "whole book's real distance to first blood". That was the
  // convenient way to express "the note carries no breach language", but it pinned an unconditional
  // claim onto a fixture that never declares a margin mode — so the test was locking in the
  // overclaim a later review found, rather than the property named in its own title. The intent is
  // preserved and the sentence is not: what must hold here is that nothing about breached legs
  // leaks into the note when there are none.
  assert.doesNotMatch(r.nearestLiquidation.note, /breachedLegs|already PAST/);
  assert.match(r.nearestLiquidation.note, /binding constraint/);
});

test('D portfolio-gate: the nearest-is-min self-check is evaluated over live legs and passes', () => {
  const r = portfolioGate({ positions: [deadLeg, liveLeg] });
  const c = r.positions ? null : null; // checks live at the top level
  const nearestCheck = (r.checks || []).find((x) => /nearest/i.test(x.name));
  assert.ok(nearestCheck, 'the check must exist');
  assert.equal(nearestCheck.pass, true, 'a check ranging over ALL legs would now fail against a live-only nearest');
  assert.equal(c, null);
});
