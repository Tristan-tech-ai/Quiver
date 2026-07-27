'use strict';

// NEGATIVE TESTS.
//
// A circuit you have only ever watched accept is not a circuit you have tested.
// An under-constrained circuit fails silently, in the direction of accepting
// garbage, so every case below states what it would mean if the case PASSED.
//
// Two failure surfaces, and they are not the same claim:
//
//   (1) WITNESS-GENERATION failure. The R1CS is unsatisfiable for these inputs,
//       so no honest prover can build a witness. Tests the CIRCUIT.
//   (2) VERIFICATION failure. A proof exists but does not check against the
//       claimed public signals. Tests the VERIFIER, which is the thing an
//       on-chain contract actually runs.
//
// Both are exercised. (1) alone would be a weaker result than it looks, because
// a malicious prover does not run the witness generator.
//
// Usage: node scripts/negative.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const snarkjs = require('snarkjs');
const scale = require('../src/scale');

const BUILD = path.join(__dirname, '..', 'build');
const WASM = path.join(BUILD, 'liquidation_js', 'liquidation.wasm');
const ZKEY = path.join(BUILD, 'liquidation_final.zkey');
const R1CS = path.join(BUILD, 'liquidation.r1cs');
const VKEY = path.join(BUILD, 'verification_key.json');

// BN254 scalar field order — the modulus circom arithmetic lives in.
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SCALE = scale.SCALE;

const POSITION = { M: 5000, q: 0.5, P0: 100000, s: 1, mmr: 0.005 };

const results = [];
function record(id, expectation, outcome, detail) {
  const pass = expectation === outcome;
  results.push({ id, expectation, outcome, pass, detail });
  const tag = pass ? 'PASS' : '*** FAIL ***';
  console.log(`  [${tag}] ${id}`);
  console.log(`           expected ${expectation}, got ${outcome}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

// Try to build a witness. Returns {ok, err}. Never throws.
async function tryWitness(raw) {
  const tmp = path.join(os.tmpdir(), `neg_${Math.random().toString(36).slice(2)}.wtns`);
  try {
    await snarkjs.wtns.calculate(raw, WASM, tmp);
    fs.unlinkSync(tmp);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    const m = String(e.message || e).replace(/\s+/g, ' ').trim();
    return { ok: false, err: m.slice(0, 150) };
  }
}

const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));

async function main() {
  console.log(`negative.js — ${new Date().toISOString()}`);

  for (const f of [WASM, ZKEY, VKEY, R1CS]) {
    if (!fs.existsSync(f)) throw new Error(`missing artifact: ${f}. Run setup first.`);
  }
  const vkey = JSON.parse(fs.readFileSync(VKEY, 'utf8'));

  const honest = scale.toCircuitInputs(POSITION);
  const honestRaw = scale.toWitnessInput(honest);
  const R0 = scale.residual(honest);
  const TOL = scale.toleranceBound(honest);

  console.log('\nReference position (all six inputs are PUBLIC):');
  console.log(' ', JSON.stringify(POSITION));
  console.log('  scaled:', JSON.stringify(honestRaw));
  console.log(`  R   = ${R0}`);
  console.log(`  tol = ${TOL}`);
  console.log(`  2|R|/tol = ${Number(2n * scale.abs(R0)) / Number(TOL)}`);

  // -----------------------------------------------------------------------
  console.log('\n=== 0. CONTROL: the honest witness must be ACCEPTED ===');
  console.log('  If this fails, every rejection below is meaningless — a circuit that');
  console.log('  rejects everything trivially "passes" a negative test suite.');
  {
    const r = await tryWitness(honestRaw);
    record('control/honest-witness', 'ACCEPT', r.ok ? 'ACCEPT' : 'REJECT', r.err);
  }

  // -----------------------------------------------------------------------
  console.log('\n=== 1. WRONG P_liq — the case the brief demands ===');
  console.log('  pLiqHat displaced by delta grid steps (1 step = 1e-9 quote currency).');
  console.log('  If a large delta were ACCEPTED the circuit would be proving nothing:');
  console.log('  any price could be passed off as the liquidation price.');
  {
    const deltas = [1n, -1n, 2n, -2n, 3n, 10n, 1000n, 10n ** 6n, 10n ** 9n, 10n ** 12n];
    for (const d of deltas) {
      const bad = { ...honest, pLiqHat: honest.pLiqHat + d };
      const R = scale.residual(bad);
      const ratio = Number(2n * scale.abs(R)) / Number(TOL);
      const r = await tryWitness(str(bad));
      // delta of +/-1 grid step is INSIDE the proven tolerance by construction;
      // the honest claim is |P_proven - P_canonical| <= 1e-9, not equality.
      const expectation = scale.abs(d) <= 1n && ratio <= 1 ? 'ACCEPT' : 'REJECT';
      record(
        `wrong-pliq/delta=${d}`,
        expectation,
        r.ok ? 'ACCEPT' : 'REJECT',
        `2|R|/tol=${ratio.toExponential(3)}`
      );
    }
  }

  // -----------------------------------------------------------------------
  console.log('\n=== 2. How far can P_liq actually move? (measured, not reasoned) ===');
  console.log('  Binary search for the largest displacement the circuit still accepts.');
  {
    let lo = 0n, hi = 1n;
    while (hi < 10n ** 15n) {
      const r = await tryWitness(str({ ...honest, pLiqHat: honest.pLiqHat + hi }));
      if (!r.ok) break;
      lo = hi; hi *= 2n;
    }
    while (lo + 1n < hi) {
      const mid = (lo + hi) / 2n;
      const r = await tryWitness(str({ ...honest, pLiqHat: honest.pLiqHat + mid }));
      if (r.ok) lo = mid; else hi = mid;
    }
    let lo2 = 0n, hi2 = 1n;
    while (hi2 < 10n ** 15n) {
      const r = await tryWitness(str({ ...honest, pLiqHat: honest.pLiqHat - hi2 }));
      if (!r.ok) break;
      lo2 = hi2; hi2 *= 2n;
    }
    while (lo2 + 1n < hi2) {
      const mid = (lo2 + hi2) / 2n;
      const r = await tryWitness(str({ ...honest, pLiqHat: honest.pLiqHat - mid }));
      if (r.ok) lo2 = mid; else hi2 = mid;
    }
    const window = lo + lo2;
    console.log(`  max accepted displacement  up: +${lo} grid steps`);
    console.log(`  max accepted displacement down: -${lo2} grid steps`);
    console.log(`  total accepted window: ${window + 1n} grid steps = ${scale.fromScaled(window)} quote currency`);
    record(
      'pliq-window/<=1-grid-step',
      'ACCEPT',
      lo <= 1n && lo2 <= 1n ? 'ACCEPT' : 'REJECT',
      `window +${lo}/-${lo2}`
    );
    results.measuredWindow = { up: lo.toString(), down: lo2.toString() };
  }

  // -----------------------------------------------------------------------
  console.log('\n=== 3. Structural violations — the guards on the input domain ===');
  {
    const cases = [
      ['side/s=0', { ...honest, s: 0 }, 'zero side makes the identity degenerate'],
      ['side/s=2', { ...honest, s: 2 }, 'side must be exactly +1 or -1'],
      ['side/s=-2', { ...honest, s: -2 }, 'side must be exactly +1 or -1'],
      ['size/q=0', { ...honest, qHat: 0n }, 'q=0 collapses the identity to M==0'],
      ['mmr/=1', { ...honest, mmrHat: SCALE }, 'maintenance rate must be < 1'],
      ['mmr/>1', { ...honest, mmrHat: SCALE + 1n }, 'maintenance rate must be < 1'],
    ];
    for (const [id, bad, why] of cases) {
      const r = await tryWitness(str(bad));
      record(id, 'REJECT', r.ok ? 'ACCEPT' : 'REJECT', why);
    }
  }

  // -----------------------------------------------------------------------
  console.log('\n=== 4. Field-wrap attack — negatives disguised as huge field elements ===');
  console.log('  The field has no order. p-1 IS -1 arithmetically. Without the Num2Bits');
  console.log('  range checks a prover could hand in "negative" margin or size and');
  console.log('  balance the residual with values the spec has no meaning for.');
  {
    const cases = [
      ['wrap/mHat=-1', { ...honest, mHat: P - 1n }],
      ['wrap/qHat=-q', { ...honest, qHat: P - honest.qHat }],
      ['wrap/p0Hat=-P0', { ...honest, p0Hat: P - honest.p0Hat }],
      ['wrap/pLiqHat=-P', { ...honest, pLiqHat: P - honest.pLiqHat }],
      ['wrap/mmrHat=-mmr', { ...honest, mmrHat: P - honest.mmrHat }],
      ['wrap/mHat=2^80', { ...honest, mHat: 1n << 80n }],
      ['wrap/qHat=2^60', { ...honest, qHat: 1n << 60n }],
      ['wrap/pLiqHat=2^60', { ...honest, pLiqHat: 1n << 60n }],
      ['wrap/mmrHat=2^30', { ...honest, mmrHat: 1n << 30n }],
    ];
    for (const [id, bad] of cases) {
      const r = await tryWitness(str(bad));
      record(id, 'REJECT', r.ok ? 'ACCEPT' : 'REJECT', r.err);
    }
  }

  // -----------------------------------------------------------------------
  console.log('\n=== 5. SOLVE-FOR-MARGIN: the circuit accepts any price you pay for ===');
  console.log('  Every input is public and free. Pick ANY pLiqHat, then solve the identity');
  console.log('  for the mHat that satisfies it. If that mHat lands on the 1e-9 grid and');
  console.log('  inside 80 bits, the circuit ACCEPTS — and is right to. The statement is');
  console.log('  "these six numbers satisfy the identity", not "these six numbers are your');
  console.log('  position". This is the load-bearing limitation of the whole artifact.');
  console.log('');
  console.log('  A first draft of this test asserted REJECT and "passed" for the wrong');
  console.log('  reason: mHat was truncated by BigInt division, leaving a remainder that');
  console.log('  broke the residual bound. The range check was never what rejected it.');
  console.log('  Recorded because a check that passes for a reason you did not intend is');
  console.log('  not a check — it is a mirror.');
  {
    const sB = BigInt(honest.s);
    for (const target of [60000n, 1n, 999999999n]) {
      const pL = target * SCALE;
      const num = qPmmrMinusTerm(honest, pL, sB);
      const exact = num % (SCALE * SCALE) === 0n;
      const mFix = num / (SCALE * SCALE);
      const inRange = mFix >= 0n && mFix < 1n << 80n;
      const bad = { ...honest, pLiqHat: pL, mHat: mFix < 0n ? P + mFix : mFix };
      const R = scale.residual({ ...bad, mHat: mFix });
      const ratio = Number(2n * scale.abs(R)) / Number(scale.toleranceBound(bad));
      // Expectation is derived, not hoped for: it accepts iff the solved margin is
      // an exact non-negative in-range grid value AND the residual bound holds.
      const expectation = exact && inRange && 2n * scale.abs(R) <= scale.toleranceBound(bad)
        ? 'ACCEPT' : 'REJECT';
      const r = await tryWitness(str(bad));
      record(
        `solve-for-margin/P_liq=${target}`,
        expectation,
        r.ok ? 'ACCEPT' : 'REJECT',
        `needs M=${mFix} (exact=${exact}, inRange=${inRange}), 2|R|/tol=${ratio.toExponential(2)}`
      );
    }
    console.log('  ^ NOT a circuit bug. The proof binds the six values to each other.');
    console.log('    Binding them to a customer\'s actual position needs a signature over');
    console.log('    the request or on-chain state, and is OUTSIDE this artifact.');
  }

  // -----------------------------------------------------------------------
  console.log('\n=== 7. VERIFIER tests — a real proof, then tampered on the wire ===');
  console.log('  This is what an on-chain contract runs. A malicious prover never runs');
  console.log('  the witness generator, so sections 1-5 alone would not settle soundness.');
  {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(honestRaw, WASM, ZKEY);
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    record('verify/untampered', 'ACCEPT', ok ? 'ACCEPT' : 'REJECT');
    console.log(`  public signals (${publicSignals.length}): ${JSON.stringify(publicSignals)}`);

    for (let i = 0; i < publicSignals.length; i++) {
      const tampered = [...publicSignals];
      tampered[i] = (BigInt(tampered[i]) + 1n).toString();
      const v = await snarkjs.groth16.verify(vkey, tampered, proof);
      record(`verify/tamper-signal[${i}]`, 'REJECT', v ? 'ACCEPT' : 'REJECT', `${publicSignals[i]} -> ${tampered[i]}`);
    }

    // Tamper the proof itself.
    const bendA = JSON.parse(JSON.stringify(proof));
    bendA.pi_a[0] = (BigInt(bendA.pi_a[0]) + 1n).toString();
    record('verify/tamper-pi_a', 'REJECT',
      (await snarkjs.groth16.verify(vkey, publicSignals, bendA)) ? 'ACCEPT' : 'REJECT');

    const bendC = JSON.parse(JSON.stringify(proof));
    bendC.pi_c[0] = (BigInt(bendC.pi_c[0]) + 1n).toString();
    record('verify/tamper-pi_c', 'REJECT',
      (await snarkjs.groth16.verify(vkey, publicSignals, bendC)) ? 'ACCEPT' : 'REJECT');

    // Identity points — the classic "empty proof" a naive verifier might wave through.
    const zeroed = JSON.parse(JSON.stringify(proof));
    zeroed.pi_a = ['0', '1', '1']; zeroed.pi_b = [['0', '0'], ['1', '0'], ['1', '0']]; zeroed.pi_c = ['0', '1', '1'];
    let z;
    try { z = await snarkjs.groth16.verify(vkey, publicSignals, zeroed); } catch (e) { z = false; }
    record('verify/identity-points', 'REJECT', z ? 'ACCEPT' : 'REJECT', 'all-zero proof');

    // A proof for a DIFFERENT position replayed against these public signals.
    const other = scale.toCircuitInputs({ M: 9000, q: 1.25, P0: 42000, s: -1, mmr: 0.01 });
    const p2 = await snarkjs.groth16.fullProve(scale.toWitnessInput(other), WASM, ZKEY);
    record('verify/replay-other-proof', 'REJECT',
      (await snarkjs.groth16.verify(vkey, publicSignals, p2.proof)) ? 'ACCEPT' : 'REJECT',
      'proof from a different position, claimed against these signals');
    record('verify/other-proof-own-signals', 'ACCEPT',
      (await snarkjs.groth16.verify(vkey, p2.publicSignals, p2.proof)) ? 'ACCEPT' : 'REJECT',
      'short side, sanity');

    fs.writeFileSync(path.join(BUILD, 'proof.json'), JSON.stringify(proof, null, 2));
    fs.writeFileSync(path.join(BUILD, 'public.json'), JSON.stringify(publicSignals, null, 2));
  }

  // -----------------------------------------------------------------------
  console.log('\n=== 8. R1CS-level: tamper the WITNESS, bypassing the generator ===');
  console.log('  The witness generator is the honest prover. A cheater edits the witness');
  console.log('  vector directly. wtns check tests the constraint system itself.');
  {
    const wpath = path.join(BUILD, 'honest.wtns');
    await snarkjs.wtns.calculate(honestRaw, WASM, wpath);
    const clean = await snarkjs.wtns.check(R1CS, wpath);
    record('r1cs/honest-witness-checks', 'ACCEPT', clean ? 'ACCEPT' : 'REJECT');

    // Witness layout: [1, ...public outputs, ...public inputs, ...private].
    // Outputs come first (residual, tolerance), then the six public inputs.
    const buf = fs.readFileSync(wpath);
    const tpath = path.join(BUILD, 'tampered.wtns');
    for (const idx of [1, 2, 3, 4, 5, 6, 7, 8]) {
      fs.writeFileSync(tpath, bumpWitness(buf, idx));
      let c;
      try { c = await snarkjs.wtns.check(R1CS, tpath); } catch (e) { c = false; }
      record(`r1cs/tamper-witness[${idx}]`, 'REJECT', c ? 'ACCEPT' : 'REJECT');
    }
    try { fs.unlinkSync(tpath); } catch (_) {}
  }

  // -----------------------------------------------------------------------
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`TOTAL: ${results.length} cases, ${results.length - failed.length} as expected, ${failed.length} NOT as expected`);
  if (failed.length) {
    console.log('\nCases that did not behave as expected:');
    for (const f of failed) console.log(`  ${f.id}: expected ${f.expectation}, got ${f.outcome} — ${f.detail || ''}`);
  }
  console.log(JSON.stringify({
    MEASURED: {
      at: new Date().toISOString(),
      total: results.length,
      asExpected: results.length - failed.length,
      unexpected: failed.map((f) => f.id),
      pliqWindow: results.measuredWindow,
    },
  }));
  process.exit(failed.length ? 1 : 0);
}

// The mHat that would drive R to zero for a chosen pLiqHat:
//   0 = mHat*S^2 + s*qHat*(P-P0)*S - qHat*P*mmrHat
//   mHat = (qHat*P*mmrHat - s*qHat*(P-P0)*S) / S^2
function qPmmrMinusTerm(h, pL, sB) {
  return h.qHat * pL * h.mmrHat - sB * h.qHat * (pL - h.p0Hat) * SCALE;
}

// .wtns format: magic(4) version(4) nSections(4), then sections
// [id(4) len(8) data]. Section 1 = header (n8(4), prime(n8), nWitness(4)).
// Section 2 = the witness values, each n8 bytes little-endian.
function bumpWitness(buf, index) {
  const out = Buffer.from(buf);
  let off = 12;
  let n8 = 32, dataOff = null;
  while (off < out.length) {
    const id = out.readUInt32LE(off);
    const len = Number(out.readBigUInt64LE(off + 4));
    const body = off + 12;
    if (id === 1) n8 = out.readUInt32LE(body);
    if (id === 2) dataOff = body;
    off = body + len;
  }
  if (dataOff === null) throw new Error('no witness section');
  const at = dataOff + index * n8;
  const v = BigInt('0x' + Buffer.from(out.subarray(at, at + n8)).reverse().toString('hex'));
  const nv = (v + 1n) % P;
  const hex = nv.toString(16).padStart(n8 * 2, '0');
  Buffer.from(hex, 'hex').reverse().copy(out, at);
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
