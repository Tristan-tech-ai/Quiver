// GATE B7-3 — the three SIGNED greek identities, swept and proved.
//
// greeksfp covers vega against gamma, both strictly positive. These three are not: theta is negative,
// vanna takes either sign, and d1 and d2 cross zero at their own strikes. Each is split into a
// positive magnitude identity and a boolean sign relation, and BOTH halves are checked here. Checking
// only the magnitudes would certify |theta| and say nothing about whether the option decays, which is
// the entire content of theta.
//
// Run: node zk/scripts/gateB7-3-signed-sweep.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD, checklist, proveVerifyRefuse, shutdown } from './lib/gatekit.mjs';
import { load } from './service-root.mjs';
import { plonkFacts } from './circuit-facts.mjs';

const { black76 } = await load(import.meta.url, 'engine/black76.js');
const RELATIVE_D = 25000000n, DE_MIN = -12, DE_MAX = 12;
const abs = (v) => (v < 0n ? -v : v);

function mant(x) {
  const neg = x < 0; x = Math.abs(x);
  if (!(x > 0) || !Number.isFinite(x)) return null;
  let e = 0, v = x;
  while (v < 1e8) { v *= 10; e++; if (e > 200) return null; }
  while (v >= 1e9) { v /= 10; e--; if (e < -200) return null; }
  let m = BigInt(Math.round(v));
  if (m >= 1000000000n) { m /= 10n; e -= 1; }
  return { m, e, s: neg ? 1 : 0 };
}
const p10 = (d) => (d >= 0 ? [10n ** BigInt(d), 1n] : [1n, 10n ** BigInt(-d)]);

let seed = 20260729;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function encode(F, K, T, sg, type) {
  const g = black76(F, K, T, sg, type, 0);
  if (!g || !(g.vega > 0) || g.volga === 0 || g.vanna === 0 || g.theta === 0) return null;
  if (g.d1 === 0 || g.d2 === 0 || !(g.d1 - g.d2 > 0)) return null;

  const V = mant(g.vega), S = mant(sg), Tm = mant(T), Fm = mant(F);
  const D1 = mant(g.d1), D2 = mant(g.d2), DD = mant(g.d1 - g.d2);
  const VO = mant(g.volga), VA = mant(g.vanna), TH = mant(g.theta);
  const all = [V, S, Tm, Fm, D1, D2, DD, VO, VA, TH];
  if (all.some((x) => !x)) return null;
  if (all.some((x) => x.e < 0 || x.e > 511)) return { outOfDomain: true };

  const dC = (V.e + D1.e + D2.e + 2) - (VO.e + S.e);
  const dD = (V.e + D2.e) - (VA.e + Fm.e + DD.e);
  const dE = (V.e + S.e + 2) - (TH.e + Tm.e);
  if ([dC, dD, dE].some((d) => d < DE_MIN || d > DE_MAX)) return { outOfDomain: true, dC, dD, dE };

  const [lC, rC] = p10(dC), [lD, rD] = p10(dD), [lE, rE] = p10(dE);
  const cL = VO.m * S.m * lC,      cR = V.m * D1.m * D2.m * rC;
  const dL = VA.m * Fm.m * DD.m * lD, dR = V.m * D2.m * rD;
  const eL = TH.m * 730n * Tm.m * lE, eR = V.m * 100n * S.m * rE;

  // The sign relations the circuit enforces, checked here against the engine's actual signs.
  const signsOk = VO.s === (D1.s ^ D2.s) && VA.s === (1 - D2.s) && TH.s === 1;

  const used = (a, b) => Number(abs(a - b) * 2n * RELATIVE_D * 1000000n / (a + b)) / 1e6;
  return {
    witness: {
      vegaM: String(V.m), sigM: String(S.m), tM: String(Tm.m), fM: String(Fm.m),
      d1M: String(D1.m), d2M: String(D2.m), dDiffM: String(DD.m),
      volgaM: String(VO.m), vannaM: String(VA.m), thetaM: String(TH.m),
      vegaE: String(V.e), sigE: String(S.e), tE: String(Tm.e), fE: String(Fm.e),
      d1E: String(D1.e), d2E: String(D2.e), dDiffE: String(DD.e),
      volgaE: String(VO.e), vannaE: String(VA.e), thetaE: String(TH.e),
      d1S: String(D1.s), d2S: String(D2.s), volgaS: String(VO.s), vannaS: String(VA.s), thetaS: String(TH.s),
    },
    signsOk,
    usedC: used(cL, cR), usedD: used(dL, dR), usedE: used(eL, eR),
    volga: g.volga, vanna: g.vanna, theta: g.theta,
  };
}

const { record, failed } = checklist();
console.log(`GATE B7-3 — signed greek identities, against the real black76 — ${new Date().toISOString()}\n`);

const RUNS = 4000;
let kept = 0, outOfDomain = 0, signFails = 0, violations = 0;
let wC = 0, wD = 0, wE = 0, worstCase = null, smallest = Infinity;
for (let i = 0; i < RUNS; i++) {
  const F = 10 ** (1 + rand() * 4);
  const e = encode(F, F * (0.3 + rand() * 2.7), 7 / 365 + rand() * 2, 0.2 + rand() * 2.3, rand() < 0.5 ? 'call' : 'put');
  if (!e) continue;
  if (e.outOfDomain) { outOfDomain++; continue; }
  kept++;
  if (!e.signsOk) signFails++;
  const worst = Math.max(e.usedC, e.usedD, e.usedE);
  if (worst > 1) violations++;
  smallest = Math.min(smallest, Math.abs(e.volga), Math.abs(e.vanna));
  wC = Math.max(wC, e.usedC); wD = Math.max(wD, e.usedD); wE = Math.max(wE, e.usedE);
  if (!worstCase || worst > Math.max(worstCase.usedC, worstCase.usedD, worstCase.usedE)) worstCase = e;
}

console.log(`  surfaces sampled   : ${kept} of ${RUNS}`);
console.log(`  outside the domain : ${outOfDomain}`);
console.log(`  sign relation fails: ${signFails}`);
console.log(`  bound violations   : ${violations}`);
console.log(`  worst bound used   : volga ${(wC * 100).toFixed(1)}% · vanna ${(wD * 100).toFixed(1)}% · theta ${(wE * 100).toFixed(1)}%`);
console.log(`  smallest |volga| or |vanna| proved: ${smallest.toExponential(2)}\n`);

record('every sign relation holds against the engine', signFails === 0,
  `s_volga = s_d1 XOR s_d2, s_vanna = NOT s_d2, s_theta = 1 — checked on all ${kept}`);
record('every magnitude bound holds', violations === 0,
  `worst ${(Math.max(wC, wD, wE) * 100).toFixed(1)}% of an 8e-8 relative bound`);
record('all three bounds are tight, not generous', wC > 0.02 && wD > 0.02 && wE > 0.02,
  `volga ${(wC * 100).toFixed(1)}% · vanna ${(wD * 100).toFixed(1)}% · theta ${(wE * 100).toFixed(1)}%`);
record('greeks the shared grid could not represent are covered', smallest < 1e-8,
  `smallest magnitude ${smallest.toExponential(2)}`);
record('the greeks came from the engine', typeof black76 === 'function', 'black76 imported and called');

console.log('\nBuilding a proof from the worst case the sweep found:');
console.log(`  volga ${worstCase.volga.toExponential(3)} · vanna ${worstCase.vanna.toExponential(3)} · theta ${worstCase.theta.toExponential(3)}`);
const { publicSignals, proveMs } = await proveVerifyRefuse('greekssigned', worstCase.witness, { record });

const f = plonkFacts(path.join(BUILD, 'greekssigned_plonk.zkey'));
const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(70)}`);
console.log(`GATE B7-3: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log(`  ${f.nConstraints} Plonk constraints · domain ${f.domainSize} · proved in ${proveMs} ms`);
console.log('  NOTHING SERVED, NOTHING DEPLOYED.');

writeFileSync(path.join(BUILD, 'gateB7-3-signed-sweep.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, samples: RUNS, kept, outOfDomain, signFails, violations,
  worstUsed: { volga: wC, vanna: wD, theta: wE }, smallestMagnitude: smallest,
  plonkConstraints: f.nConstraints, domainSize: f.domainSize, proveMs,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
