// GATE B7-2 — does the per-value encoding actually hold, proved and measured?
//
// gateB7-1 fails: the shared 1e-9 grid destroys identity B for any option whose gamma is a few grid
// steps, which is most of a real book. This is the same statement on a per-value scale, and it is the
// gate that decides whether the fix is real or only arithmetic on paper.
//
// Two halves, and the second is the one that can fail:
//   1. the encoder's residual bound holds over thousands of real surfaces
//   2. an actual PROOF is built from a real witness, verifies, and REFUSES every perturbation
//
// Run: node zk/scripts/gateB7-2-greeksfp-sweep.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, checklist, proveVerifyRefuse, shutdown } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';
import { plonkFacts } from './circuit-facts.mjs';

const { black76 } = await load(import.meta.url, 'engine/black76.js');

const RELATIVE_D = 25000000n;   // the circuit's constant, mirrored so the gate measures what it proves
const DE_MIN = 20, DE_MAX = 50;
const abs = (v) => (v < 0n ? -v : v);

/** x = m · 10^-e with m in [1e8, 1e9). Returns null when x cannot be normalised at all. */
function mantissa(x) {
  if (!(x > 0) || !Number.isFinite(x)) return null;
  let e = 0, v = x;
  while (v < 1e8) { v *= 10; e++; if (e > 200) return null; }
  while (v >= 1e9) { v /= 10; e--; if (e < -200) return null; }
  const m = BigInt(Math.round(v));
  // Rounding can push 999999999.6 to 1e9, which is outside the window the circuit enforces.
  if (m < 100000000n || m >= 1000000000n) return { m: m / 10n, e: e - 1 };
  return { m, e };
}

let seed = 20260729;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function encode(F, K, T, sigma, type) {
  const g = black76(F, K, T, sigma, type, 0);
  if (!g || !(g.vega > 0) || !(g.gamma > 0)) return null;

  const V = mantissa(g.vega), G = mantissa(g.gamma);
  const Fm = mantissa(F), Sm = mantissa(sigma), Tm = mantissa(T);
  if (!V || !G || !Fm || !Sm || !Tm) return null;
  if ([V, G, Fm, Sm, Tm].some((x) => x.e < 0 || x.e > 255)) return { outOfDomain: true };

  const dE = G.e + 2 * Fm.e + Sm.e + Tm.e - V.e;
  if (dE < DE_MIN || dE > DE_MAX) return { outOfDomain: true, dE };

  const lhs = V.m * 100n * (10n ** BigInt(dE));
  const rhs = G.m * Fm.m * Fm.m * Sm.m * Tm.m;
  const R = lhs - rhs;

  return {
    witness: {
      vegaM: V.m.toString(), gammaM: G.m.toString(), fM: Fm.m.toString(),
      sigM: Sm.m.toString(), tM: Tm.m.toString(),
      vegaE: String(V.e), gammaE: String(G.e), fE: String(Fm.e), sigE: String(Sm.e), tE: String(Tm.e),
    },
    R, lhs, rhs, dE, gamma: g.gamma, vega: g.vega,
    // The circuit's own condition, mirrored: 2|R|·D <= lhs + rhs.
    within: abs(R) * 2n * RELATIVE_D <= lhs + rhs,
    used: Number(abs(R) * 2n * RELATIVE_D * 1000000n / (lhs + rhs)) / 1e6,
  };
}

const { record, failed } = checklist();
console.log(`GATE B7-2 — per-value greek encoding, against the real black76 — ${new Date().toISOString()}\n`);

// ---- 1. the sweep -------------------------------------------------------------------------------
const RUNS = 4000;
let kept = 0, outOfDomain = 0, violations = 0;
let worstUsed = 0, worstCase = null, smallestGamma = Infinity;
const deSeen = new Set();
for (let i = 0; i < RUNS; i++) {
  const F = 10 ** (1 + rand() * 4);
  const e = encode(F, F * (0.3 + rand() * 2.7), 7 / 365 + rand() * 2, 0.2 + rand() * 2.3, rand() < 0.5 ? 'call' : 'put');
  if (!e) continue;
  if (e.outOfDomain) { outOfDomain++; continue; }
  kept++;
  deSeen.add(e.dE);
  smallestGamma = Math.min(smallestGamma, e.gamma);
  if (!e.within) violations++;
  if (e.used > worstUsed) { worstUsed = e.used; worstCase = e; }
}

console.log(`  surfaces sampled     : ${kept} of ${RUNS}`);
console.log(`  outside the domain   : ${outOfDomain}   (refused by the selector, never wrapped)`);
console.log(`  bound violations     : ${violations}`);
console.log(`  alignment exponents  : {${[...deSeen].sort((a, b) => a - b).join(', ')}}   selector covers [${DE_MIN}, ${DE_MAX}]`);
console.log(`  smallest gamma proved: ${smallestGamma.toExponential(2)}   (the shared grid gave this ONE step)`);
console.log(`  worst case uses      : ${(worstUsed * 100).toFixed(1)}% of the bound\n`);

record('the bound holds on every surface', violations === 0,
  `${kept} surfaces, worst uses ${(worstUsed * 100).toFixed(1)}% of an 8e-8 relative bound`);
record('no surface is lost to the encoding', outOfDomain === 0 && kept > RUNS * 0.95,
  `${kept} kept, ${outOfDomain} outside the domain — the shared grid had to exclude gamma below 1e-6 to get near this`);
record('gammas the shared grid could not represent are now proved', smallestGamma < 1e-8,
  `smallest ${smallestGamma.toExponential(2)}, which is under a hundredth of one 1e-9 grid step`);
record('the bound is tight, not generous', worstUsed > 0.05,
  `${(worstUsed * 100).toFixed(1)}% — a bound nothing approaches is not a bound the sweep has tested`);
record('the greeks came from the engine', typeof black76 === 'function',
  'black76 was imported and called; no identity was re-derived here to agree with itself');

// ---- 2. a real proof, and the refusals ----------------------------------------------------------
// A sweep says the arithmetic holds. Only a proof says the CIRCUIT holds it, and only a refusal says
// the verifier is a verifier.
console.log('\nBuilding an actual proof from the worst case the sweep found:');
console.log(`  gamma ${worstCase.gamma.toExponential(3)} · vega ${worstCase.vega.toExponential(3)} · dE ${worstCase.dE}`);
const { publicSignals, proveMs } = await proveVerifyRefuse('greeksfp', worstCase.witness, { record });

const f = plonkFacts(path.join(BUILD, 'greeksfp_plonk.zkey'));
const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B7-2: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  ${f.nConstraints} Plonk constraints · domain ${f.domainSize} · proved in ${proveMs} ms`);
console.log(`  against greeks.circom on the shared grid: 2,152 Plonk, domain 4,096, and its sweep fails.`);
console.log(`  NOTHING SERVED, NOTHING DEPLOYED. options-risk does not emit this.`);

writeFileSync(path.join(BUILD, 'gateB7-2-greeksfp-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, samples: RUNS, kept, outOfDomain, violations,
  worstBoundUsed: worstUsed, smallestGammaProved: smallestGamma,
  alignmentExponents: [...deSeen].sort((a, b) => a - b),
  plonkConstraints: f.nConstraints, domainSize: f.domainSize, proveMs,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
