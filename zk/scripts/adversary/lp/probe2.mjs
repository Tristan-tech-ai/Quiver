// PROBE 2 — (a) can the two seed exponentials be PINNED in-circuit? (b) how coarse a grid still
// reproduces the served 4-dp figure? (c) the -100 boundary. (d) field-count fractions.
import __P from '../paths.mjs';
const ENGINE = __P.vtUrl("src/engine/lpRisk.js");
const { lpRisk } = await import(ENGINE);

const ilOfRatio = (r) => (r > 0 ? (2 * Math.sqrt(r)) / (1 + r) - 1 : -1);
function engineQuad(v) {
  const sd = Math.sqrt(v);
  let sum = 0, w = 0;
  const N = 400, lo = -6, hi = 6;
  for (let i = 0; i <= N; i++) {
    const z = lo + ((hi - lo) * i) / N;
    sum += Math.exp(-0.5 * z * z) * ilOfRatio(Math.exp(-0.5 * v + sd * z));
    w += Math.exp(-0.5 * z * z);
  }
  return sum / w;
}

// ================================================================================
// (a) PINNING exp WITHOUT exp. p = exp(h/2 · sd) with h/2 = 0.015 — a SMALL argument.
//     s0 = exp(-v/4 - 3 sd) — a large one, reached by Taylor at arg/2^m then m squarings.
//     Both are polynomial statements a circuit can carry. Measured, not assumed.
// ================================================================================
function taylorExp(x, terms) { let t = 1, s = 1; for (let k = 1; k <= terms; k++) { t = (t * x) / k; s += t; } return s; }
function expBySquaring(x, m, terms) { let a = taylorExp(x / 2 ** m, terms); for (let k = 0; k < m; k++) a *= a; return a; }

console.log('=== (a) pinning the two seed exponentials with polynomial arithmetic only ===');
console.log('  p = exp(0.015·sd):   sd range comes from v range. Terms needed for |rel err| < 1e-12:');
for (const vMax of [1, 10, 100, 250]) {
  const sd = Math.sqrt(vMax), x = 0.015 * sd;
  let need = null;
  for (let t = 1; t <= 20; t++) { if (Math.abs(taylorExp(x, t) / Math.exp(x) - 1) < 1e-12) { need = t; break; } }
  console.log(`    v<=${String(vMax).padEnd(5)} sd=${sd.toFixed(4)}  x=${x.toFixed(6)}  ${need} Taylor terms  (rel err ${Math.abs(taylorExp(x, need) / Math.exp(x) - 1).toExponential(2)})`);
}
console.log('  s0 = exp(-(v/4 + 3·sd)):  argument magnitude, and Taylor-after-m-squarings cost:');
for (const vMax of [1, 10, 100, 250]) {
  const sd = Math.sqrt(vMax), arg = vMax / 4 + 3 * sd;
  let best = null;
  for (let m = 0; m <= 16; m++) for (let t = 1; t <= 14; t++) {
    const got = expBySquaring(-arg, m, t);
    if (Math.abs(got / Math.exp(-arg) - 1) < 1e-12) { if (!best || m + t < best.m + best.t) best = { m, t, got }; }
  }
  console.log(`    v<=${String(vMax).padEnd(5)} |arg|=${arg.toFixed(4)}  cheapest: ${best.t} Taylor terms then ${best.m} squarings = ${best.t + best.m} muls  (rel err ${Math.abs(best.got / Math.exp(-arg) - 1).toExponential(2)})`);
}

// ================================================================================
// (b) HOW COARSE A GRID still reproduces the SERVED 4-dp expectedIlPct? A proof about a
//     coarser sum certifies the served number only if it rounds to the served number.
// ================================================================================
function subQuad(v, stride) {
  const N = 400, lo = -6, h = 12 / N;
  let sum = 0, w = 0;
  for (let i = 0; i <= N; i += stride) {
    const z = lo + h * i, pdf = Math.exp(-0.5 * z * z);
    sum += pdf * ilOfRatio(Math.exp(-0.5 * v + Math.sqrt(v) * z));
    w += pdf;
  }
  return sum / w;
}
console.log('\n=== (b) sub-grid of the SAME 401 nodes: worst |gap| to the 401-point sum ===');
console.log('  stride  points   worst |E[IL] gap| over 3000 log-spaced v in [1e-6, 250]   rounds to served 4dp everywhere?');
const SERVED_HALF = 5e-7;   // expectedIlPct = round(frac*100, 4) -> half a step is 5e-5 pct = 5e-7 frac
for (const stride of [1, 2, 4, 5, 8, 10, 16, 20, 25, 40, 50, 80, 100]) {
  let worst = 0, worstV = 0, misses = 0, n = 0;
  for (let k = 1; k <= 3000; k++) {
    const v = Math.exp(Math.log(1e-6) + (k / 3000) * (Math.log(250) - Math.log(1e-6)));
    const a = engineQuad(v), b = subQuad(v, stride);
    const g = Math.abs(a - b);
    if (g > worst) { worst = g; worstV = v; }
    if (Math.round(b * 100 * 1e4) / 1e4 !== Math.round(a * 100 * 1e4) / 1e4) misses++;
    n++;
  }
  const pts = Math.floor(400 / stride) + 1;
  console.log(`  ${String(stride).padEnd(7)} ${String(pts).padEnd(8)} ${worst.toExponential(3)} at v=${worstV.toPrecision(5).padEnd(10)}  ${misses === 0 ? 'YES' : `no — ${misses}/${n} differ`}${worst < SERVED_HALF ? '   (under the 5e-7 half-step)' : ''}`);
}

// ================================================================================
// (c) THE -100 BOUNDARY. At large variance the engine serves expectedIlPct == -100 exactly.
//     Its own boundedness check reads `e <= 0 && e > -100`. Does it then FAIL on a served call?
// ================================================================================
console.log('\n=== (c) the engine boundedness check at the -100% floor ===');
for (const [sig, T] of [[1.0, 100], [1.5, 200], [2.0, 365], [3.0, 365], [5, 365]]) {
  const res = lpRisk({ volatility: sig, horizonPeriods: T });
  const e = res.expectedDivergence.expectedIlPct;
  const chk = res.checks.find((c) => c.name.startsWith('boundedness: reported expected'));
  console.log(`  sigma=${String(sig).padEnd(4)} T=${String(T).padEnd(4)} v=${(sig * sig * T).toFixed(1).padEnd(8)} expectedIlPct=${String(e).padEnd(9)} check.pass=${chk.pass}  ok=${res.ok}`);
}

// ================================================================================
// (d) WHAT FRACTION does divergence.circom already cover? Count the NUMERIC fields the
//     service publishes per block, on a representative full call.
// ================================================================================
console.log('\n=== (d) published numeric fields, counted from a real envelope ===');
const full = lpRisk({ priceRatio: 3.4, volatility: 0.05, horizonPeriods: 30, feeAprPct: 20, capitalUsd: 100000, concentrationFactor: 1 });
const numeric = (o, pre = '') => Object.entries(o).flatMap(([k, v]) =>
  typeof v === 'number' ? [`${pre}${k}`] : (v && typeof v === 'object' && !Array.isArray(v) ? numeric(v, `${pre}${k}.`) : []));
for (const block of ['realizedIL', 'expectedDivergence', 'feeVsDivergence']) {
  if (!full[block]) { console.log(`  ${block}: absent`); continue; }
  const f = numeric(full[block], `${block}.`);
  console.log(`  ${block}: ${f.length} numeric fields -> ${f.join(', ')}`);
}
console.log(`  concentrationFactor at top level: ${full.concentrationFactor}`);
console.log('\n  which of those does the divergence circuit reach? rHat/sHat/lHat only:');
console.log('    realizedIL.priceRatio           -> rHat (public input, echoed)');
console.log('    realizedIL.impermanentLossPct   -> lHat (L = IL+1), the identity');
console.log('    realizedIL.usd                  -> il * capital, one multiply, NOT in the circuit');
