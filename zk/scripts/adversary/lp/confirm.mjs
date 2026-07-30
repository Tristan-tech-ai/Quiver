// Is exp(-v/8)-1 the TRUE expectation, or a coincidence of the engine's 401-point grid?
// Refine the grid and widen the range. If the closed form is the truth, the residual must
// shrink toward zero as the grid refines; if it is a coincidence, it will not.

import __P from '../paths.mjs';
const ilOfRatio = (r) => (r > 0 ? (2 * Math.sqrt(r)) / (1 + r) - 1 : -1);
function quad(v, N, R) {
  const sd = Math.sqrt(v);
  let sum = 0, w = 0;
  for (let i = 0; i <= N; i++) {
    const z = -R + (2 * R * i) / N;
    const pdf = Math.exp(-0.5 * z * z);
    const r = Math.exp(-0.5 * v + sd * z);
    sum += pdf * ilOfRatio(r); w += pdf;
  }
  return sum / w;
}
const closed = (v) => Math.expm1(-v / 8);

console.log('CONVERGENCE. residual = |quad(v,N,R) - (exp(-v/8)-1)|, at v = 1.125641 (the engine grid\'s worst point)\n');
console.log('   N       R      residual');
for (const [N, R] of [[400, 6], [800, 6], [1600, 6], [400, 8], [800, 8], [1600, 8], [3200, 10], [6400, 12], [12800, 14], [25600, 16]]) {
  const v = 1.125641;
  console.log(`  ${String(N).padStart(6)}  ${String(R).padStart(5)}    ${Math.abs(quad(v, N, R) - closed(v)).toExponential(4)}`);
}

console.log('\nSAME at v = 4 and v = 25');
for (const v of [4, 25]) {
  const line = [[400, 6], [1600, 8], [6400, 12], [25600, 16]].map(([N, R]) => `N=${N},R=${R}: ${Math.abs(quad(v, N, R) - closed(v)).toExponential(3)}`);
  console.log(`  v=${v}  ` + line.join('   '));
}

// Independent check by a completely different method: Gauss-Legendre on u = Phi(z) is awkward,
// so use the substitution-free Monte Carlo with antithetic pairs and a huge sample, plus
// an independent HIGH-ORDER Gauss-Hermite rule built from scratch (Golub-Welsch on the
// Jacobi matrix for the Hermite weight). Two methods that share no code with the engine.
function gaussHermiteProb(n) {
  // Jacobi matrix for the PROBABILISTS' Hermite weight e^{-x^2/2}/sqrt(2pi):
  // diag 0, off-diagonal sqrt(k). Eigenvalues = nodes, weights = (first eigvec component)^2.
  const a = new Float64Array(n), b = new Float64Array(n);
  for (let k = 1; k < n; k++) b[k] = Math.sqrt(k);
  // symmetric tridiagonal eigen-decomposition, implicit QL with Wilkinson shift
  const d = Array.from(a), e = Array.from(b);
  const z = []; for (let i = 0; i < n; i++) { z.push(new Float64Array(n)); z[i][i] = 1; }
  const ee = new Float64Array(n); for (let i = 0; i < n - 1; i++) ee[i] = e[i + 1]; ee[n - 1] = 0;
  for (let l = 0; l < n; l++) {
    let iter = 0;
    for (;;) {
      let m = l;
      for (; m < n - 1; m++) { const dd = Math.abs(d[m]) + Math.abs(d[m + 1]); if (Math.abs(ee[m]) <= 1e-18 * dd) break; }
      if (m === l) break;
      if (++iter > 60) throw new Error('no converge');
      let g = (d[l + 1] - d[l]) / (2 * ee[l]);
      let r = Math.hypot(g, 1);
      g = d[m] - d[l] + ee[l] / (g + (g >= 0 ? Math.abs(r) : -Math.abs(r)));
      let s = 1, c = 1, p = 0;
      for (let i = m - 1; i >= l; i--) {
        let f = s * ee[i], bb = c * ee[i];
        r = Math.hypot(f, g); ee[i + 1] = r;
        if (r === 0) { d[i + 1] -= p; ee[m] = 0; break; }
        s = f / r; c = g / r; g = d[i + 1] - p;
        r = (d[i] - g) * s + 2 * c * bb; p = s * r; d[i + 1] = g + p; g = c * r - bb;
        for (let k = 0; k < n; k++) { const t1 = z[k][i + 1], t2 = z[k][i]; z[k][i + 1] = s * t2 + c * t1; z[k][i] = c * t2 - s * t1; }
      }
      d[l] -= p; ee[l] = g; ee[m] = 0;
    }
  }
  const nodes = [], wts = [];
  for (let j = 0; j < n; j++) { nodes.push(d[j]); wts.push(z[0][j] * z[0][j]); }
  return { nodes, wts };
}
const gh = gaussHermiteProb(120);
const wsum = gh.wts.reduce((a, b) => a + b, 0);
console.log(`\nINDEPENDENT 120-node Gauss-Hermite (Golub-Welsch, no shared code). sum of weights = ${wsum.toFixed(15)} (must be 1)`);
console.log('   v          Gauss-Hermite            exp(-v/8)-1              gap');
for (const v of [0.01, 0.5, 1.125641, 4, 9, 25, 60]) {
  const sd = Math.sqrt(v);
  let s = 0;
  for (let j = 0; j < gh.nodes.length; j++) s += gh.wts[j] * ilOfRatio(Math.exp(-0.5 * v + sd * gh.nodes[j]));
  console.log(`  ${String(v).padEnd(10)} ${s.toFixed(15).padStart(20)}  ${closed(v).toFixed(15).padStart(20)}   ${Math.abs(s - closed(v)).toExponential(3)}`);
}

// Monte Carlo, antithetic, 20 million pairs at one v: a third method.
function mc(v, n) {
  const sd = Math.sqrt(v); let s = 0;
  let seed = 123456789;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed + 0.5) / 0x80000000; };
  for (let i = 0; i < n; i++) {
    const u1 = rnd(), u2 = rnd();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    s += 0.5 * (ilOfRatio(Math.exp(-0.5 * v + sd * g)) + ilOfRatio(Math.exp(-0.5 * v - sd * g)));
  }
  return s / n;
}
const v0 = 4, nmc = 4_000_000;
const m = mc(v0, nmc);
console.log(`\nMONTE CARLO antithetic, ${nmc.toLocaleString()} pairs at v=${v0}: ${m.toFixed(9)}   closed form ${closed(v0).toFixed(9)}   gap ${Math.abs(m - closed(v0)).toExponential(3)}  (MC s.e. ~ ${(0.3 / Math.sqrt(nmc)).toExponential(1)})`);
