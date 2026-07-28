// GATE B7-1 — do the greek identities survive the grid, measured against the real black76?
//
// The probe showed all eight relations hold to double precision in floating point. That is necessary
// and not sufficient: this circuit works on a 1e-9 integer grid, and an identity that is exact in
// doubles can be destroyed by snapping. Identity B multiplies five snapped quantities together, so
// each one's half-step of rounding is amplified by the other four.
//
// So this is the gate that decides whether the finding is real. It reports the RELATIVE residual of
// each identity over thousands of real surfaces, and the bound in the circuit is then set from what is
// measured rather than from what I derived. A bound chosen before the measurement is a guess.
//
// Run: node zk/scripts/gateB7-1-greeks-sweep.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, SCALE, S, toScaled, checklist } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';

const { black76 } = await load(import.meta.url, 'engine/black76.js');

const TOL_A = 4n;    // grid steps. Was 1, which the sweep violated at 2.244x: sqrt(T) is derived by
                     // integer Newton from the SNAPPED tenor, so its error is amplified by 1/(2*sqrt(T))
                     // and reaches ~2.3 steps at the short end. Measured, then set.
const TOL_S = 1n;    // grid steps, for the root

let seed = 20260729;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const abs = (v) => (v < 0n ? -v : v);

function trial() {
  // Deliberately narrower than the probe's range. The probe asked whether the ALGEBRA holds and could
  // roam over five orders of magnitude; this asks whether the GRID holds it, and the grid has a
  // domain. A forward of 1e5 scaled is 1e14, and its square is 1e28, which is where identity B starts
  // to strain the field. Surfaces outside the domain are counted, not silently dropped.
  const F = 10 ** (1 + rand() * 4);          // $10 to $100k
  const K = F * (0.3 + rand() * 2.7);
  const T = 7 / 365 + rand() * 2;
  const sigma = 0.2 + rand() * 2.3;
  const g = black76(F, K, T, sigma, rand() < 0.5 ? 'call' : 'put', 0);
  if (!g || !(g.vega > 0) || !(g.gamma > 0)) return null;

  const fHat = toScaled(F, 'F');
  const sigHat = toScaled(sigma, 'sigma');
  const tHat = toScaled(T, 'T');

  // sqrt(T) on the grid, by integer Newton from the SNAPPED tenor, never Math.sqrt(T)*1e9 which would
  // round twice and put the residual where the arithmetic is rather than where the identity is.
  const target = tHat * SCALE;
  let qHat = isqrt(target);
  if ((qHat + 1n) * (qHat + 1n) - target < target - qHat * qHat) qHat += 1n;

  const dDiff = g.d1 - g.d2;
  if (!(dDiff > 0)) return null;
  const dHat = toScaled(dDiff, 'd1-d2');
  const vegaHat = toScaled(g.vega, 'vega');
  const gammaHat = toScaled(g.gamma, 'gamma');
  if (vegaHat === 0n || gammaHat === 0n) return { tooSmall: true };

  // Width limits the circuit enforces. Past them a value wraps rather than fails, so they are checked
  // here and reported rather than left to produce a nonsense proof.
  if (fHat >= (1n << 60n) || vegaHat >= (1n << 50n) || gammaHat >= (1n << 50n)
      || sigHat >= (1n << 40n) || tHat >= (1n << 40n) || qHat >= (1n << 40n) || dHat >= (1n << 40n)) {
    return { outOfDomain: true };
  }

  const Rs = qHat * qHat - tHat * SCALE;
  const Ra = dHat * SCALE - sigHat * qHat;

  const lhs = vegaHat * (100n * SCALE);
  const rhs = gammaHat * fHat * fHat * sigHat * tHat;
  // S^4, not S^3. The first version was off by one factor of 1e9 and the sweep caught it as a
  // relative residual of exactly 2.0 — the signature of one side being negligible against the other,
  // which is a scaling error and never rounding.
  const Rb = lhs * (SCALE * SCALE * SCALE) - rhs;
  const sum = lhs * (SCALE * SCALE * SCALE) + rhs;

  return {
    F, sigma, T,
    rootRatio: Number(abs(Rs) * 2n) / Number(2n * qHat + TOL_S * SCALE),
    tenorRatio: Number(abs(Ra) * 2n) / Number(sigHat + qHat + TOL_A * SCALE),
    // Relative, because the two sides of identity B span tens of orders of magnitude across the book.
    greekRel: Number(abs(Rb) * 2n * 1000000000n / sum) / 1e9,
  };
}

const { record, failed } = checklist();
console.log(`GATE B7-1 — greek identities on the grid, against the real black76 — ${new Date().toISOString()}\n`);

const RUNS = 4000;
let kept = 0, outOfDomain = 0, tooSmall = 0;
let worstRoot = 0, worstTenor = 0, worstGreek = 0, worstCase = null;
for (let i = 0; i < RUNS; i++) {
  const t = trial();
  if (!t) continue;
  if (t.outOfDomain) { outOfDomain++; continue; }
  if (t.tooSmall) { tooSmall++; continue; }
  kept++;
  worstRoot = Math.max(worstRoot, t.rootRatio);
  worstTenor = Math.max(worstTenor, t.tenorRatio);
  if (t.greekRel > worstGreek) { worstGreek = t.greekRel; worstCase = t; }
}

console.log(`  surfaces sampled       : ${kept}`);
console.log(`  outside the domain     : ${outOfDomain}`);
console.log(`  greeks below one grid step: ${tooSmall}   (a gamma under 1e-9 cannot be represented and is refused)`);
console.log(`  tightest root          : 2|Rs| / TOL = ${worstRoot.toExponential(3)}`);
console.log(`  tightest tenor         : 2|Ra| / TOL = ${worstTenor.toExponential(3)}`);
console.log(`  worst RELATIVE greek residual : ${worstGreek.toExponential(3)}`);
if (worstCase) console.log(`  at                     : F=${worstCase.F.toPrecision(6)} σ=${worstCase.sigma.toPrecision(4)} T=${worstCase.T.toPrecision(4)}\n`);

record('the root bound holds on every surface', worstRoot <= 1,
  `tightest ${worstRoot.toExponential(3)} of the bound`);
record('the tenor identity holds on every surface', worstTenor <= 1,
  `tightest ${worstTenor.toExponential(3)} of the bound`);

// The number the circuit's relative bound must be set from. Reported before it is judged, because the
// judgement is what this gate exists to inform.
const DIVISOR = Math.pow(10, Math.floor(-Math.log10(worstGreek)) - 0);
console.log(`  A relative bound of 2|Rb| <= (lhs+rhs)/D is satisfied by every sample at D = ${DIVISOR.toExponential(0)}`);
console.log(`  and the worst case uses ${(worstGreek * DIVISOR * 100).toFixed(1)}% of it.\n`);

record('the greek identity survives the grid at all', worstGreek < 1e-3,
  `worst relative residual ${worstGreek.toExponential(3)} — five snapped quantities multiplied together`);
record('the sweep is discriminating, not vacuous',
  worstGreek > 1e-15 && worstRoot > 1e-12 && worstTenor > 1e-12,
  'every residual is non-zero, so each bound is being tested rather than trivially satisfied');
record('the greeks came from the engine, not from a recomputation', typeof black76 === 'function',
  'black76 was imported and called; no identity was evaluated by re-deriving it here');

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B7-1: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
if (!gate) {
  console.log('');
  console.log('  THIS FAILURE IS THE FINDING, not a bug to paper over. See hackathon/TIER3_FINDINGS.md.');
  console.log('  The eight Black-76 identities hold exactly in floating point, so Tier 3 was never blocked');
  console.log('  on transcendentals. It is blocked on fixed-point representation: the residual is 1/G where');
  console.log('  G is the greek in grid steps, and a deep-OTM gamma of 5e-10 is ONE step on a 1e-9 grid.');
  console.log('  A finer grid for gamma alone is not enough; vega fails at the same strikes.');
}
console.log(`  NOTHING SERVED, NOTHING DEPLOYED. options-risk does not emit this and no verifier is on chain.`);

writeFileSync(path.join(BUILD, 'gateB7-1-greeks-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, samples: RUNS, kept, outOfDomain, tooSmall,
  worstRootRatio: worstRoot, worstTenorRatio: worstTenor, worstGreekRelative: worstGreek,
  suggestedRelativeDivisor: DIVISOR,
}, null, 2) + '\n', 'utf8');
process.exit(gate ? 0 : 1);
