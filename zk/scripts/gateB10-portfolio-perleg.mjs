// GATE B10 — the portfolio leg ceiling, defeated by changing the SHAPE rather than the ceremony.
//
// THE CEILING, reproduced rather than quoted. `portfoliogate.circom` at N=3 is 2,053 R1CS and 3,970
// Plonk against hez_final_12's 4,096-gate domain: 126 gates of slack. At N=4 it is 2,736 R1CS, and the
// Plonk figure is not extrapolated here — snarkjs is asked to set it up and the count is read out of
// its own refusal. A fourth leg needs domain 8,192, so a 2^13 ceremony file.
//
// WHY A BIGGER CEREMONY IS THE WRONG ANSWER. It is a real answer to the wrong question. The service
// has NO leg cap — there is no maxItems anywhere in it and the only bound is "need at least one
// position" — and its own tests exercise an eleven-leg book. One more power of tau buys ONE more leg
// against a gap of eight, and each power roughly doubles proving time, so the wall moves from "will
// not fit" to "takes too long" and then back to "will not fit" at leg five.
//
// THE SHAPE THAT REMOVES IT. portfolio-gate's claim is two claims: every leg satisfies the liquidation
// identity, and no other leg is nearer. The first is per-leg and independent. The second is a
// comparison between numbers — and if each leg's proof PUBLISHES the two integers its distance is the
// ratio of, the comparison is arithmetic over public values that a contract can redo. So n legs is n
// independent proofs at a fixed domain plus a cross-multiplied minimum, and there is no ceiling at all.
//
// WHAT THIS GATE FOUND THAT WAS NOT KNOWN. gateB6 measured this trade and concluded Route B works. Its
// router ranks on `signals[i][NPUB-1]`, which for the liquidation circuit is `pLiqHat` — the
// liquidation PRICE. portfoliogate.circom's own header says that is a different answer: "a $64,000 BTC
// leg 1.2% away has a far larger price than a $0.62 leg 20% away, and price-ranking calls the cheap
// token the binding one." So gateB6 did not measure the portfolio minimum; it measured a price
// minimum, on a book where the two disagree. That disagreement is asserted as a FAILING condition
// below, so this gate cannot pass while quietly proving the wrong thing.
//
// Nothing is deployed. Everything runs in an in-process EVM.
//
// Run: node zk/scripts/gateB10-portfolio-perleg.mjs
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILD, S, checklist, shutdown, snarkjs } from './lib/gatekit.mjs';
import { plonkFacts } from './circuit-facts.mjs';
import { makePerLegBuilder, nearerThan, BOUNDS as WIDE } from './lib/portfolio-perleg.mjs';
import { BOUNDS as NARROW, makeBuilder as makeWideBuilder } from './lib/portfolio-witness.mjs';
import { readGas, GAS_VARIANCE_NOTE } from './lib/gas-facts.mjs';

const require = createRequire(import.meta.url);
const { record, failed } = checklist();
console.log(`GATE B10 — per-leg portfolio proofs vs the wide circuit — ${new Date().toISOString()}\n`);

const sj = await snarkjs();

// ---- 1. the ceiling, measured at N=3, N=4 and per-leg ---------------------------------------------
console.log('The leg ceiling, read from artifacts rather than quoted:\n');

const wideFacts = plonkFacts(path.join(BUILD, 'portfoliogate_plonk.zkey'));
const legFacts = plonkFacts(path.join(BUILD, 'portfolioleg_plonk.zkey'));
const r1csOf = async (n) => (await sj.r1cs.info(path.join(BUILD, `${n}.r1cs`))).nConstraints;
const wideR1cs = await r1csOf('portfoliogate');
const wide4R1cs = await r1csOf('portfoliogate4');
const legR1cs = await r1csOf('portfolioleg');

// Both inputs to the N=4 measurement are checked for presence FIRST, and their absence is a gate
// failure with the command that fixes it — never a skip. gas-facts.mjs states the principle this
// follows: a gate that silently substitutes a fallback when its input is missing reports a comparison
// it did not make. `hez_final_12.ptau` is 4.8 MB and is not committed, so a fresh clone lands here.
const R1CS_4 = path.join(BUILD, 'portfoliogate4.r1cs');
const PTAU = path.join(BUILD, 'hez_final_12.ptau');
const missing = [
  !existsSync(R1CS_4) ? 'build/portfoliogate4.r1cs — run: ./circom.exe circuits/portfoliogate4.circom --r1cs --wasm --sym -o build' : null,
  !existsSync(PTAU) ? 'build/hez_final_12.ptau — fetch: curl -o zk/build/hez_final_12.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau' : null,
].filter(Boolean);
if (missing.length) {
  record('the inputs to the N=4 measurement are present', false, `MISSING:\n           ${missing.join('\n           ')}`);
  console.log('\nRefusing to report a ceiling this checkout cannot measure.');
  await shutdown();
  process.exit(1);
}

// The N=4 Plonk count, taken from snarkjs's own gate generation rather than extrapolated from the N=3
// expansion ratio. `plonk.setup` does not throw when the circuit will not fit — it logs the count and
// RETURNS -1 — so the number is captured off a logger and the -1 is what "refused" means here. A
// try/catch around this reports nothing, which is how this check first passed while measuring nothing
// at all.
const logLines = [];
const capture = { info: (m) => logLines.push(String(m)), error: (m) => logLines.push(String(m)), warn: () => {}, debug: () => {} };
const n4Ret = await sj.plonk.setup(R1CS_4, PTAU,
  path.join(BUILD, '_n4_probe.zkey'), capture);
const n4Line = logLines.find((l) => /Plonk constraints:\s*\d+/.test(l)) || '';
const n4Plonk = n4Line ? Number(n4Line.match(/(\d+)/)[1]) : null;
const n4TooBig = logLines.find((l) => /too big for this power of tau/.test(l)) || '';
rmSync(path.join(BUILD, '_n4_probe.zkey'), { force: true });   // the probe writes a stub before refusing
record('a 4-leg build is refused by the ceremony on disk, and says by how much',
  n4Ret === -1 && n4Plonk != null && n4TooBig !== '',
  n4Plonk != null ? `snarkjs returned ${n4Ret} · "${n4TooBig}"` : `no count in: ${logLines.join(' | ')}`);

// snarkjs's own sizing, mirrored exactly: `cirPower = log2(n - 1) + 1` where its log2 is a FLOOR
// (bit-length) log2. Writing Math.ceil here instead reported 2^14 / domain 16,384 for a circuit that
// needs 2^13 / 8,192 — one clean power out, which is the shape a wrong exponent always has. So the
// result is checked against what a domain must satisfy rather than trusted.
const need4 = n4Plonk != null ? Math.max(3, Math.floor(Math.log2(n4Plonk - 1)) + 1) : null;
const domain4 = need4 ? 2 ** need4 : null;
record('the domain a 4-leg build needs is the smallest power of two that holds it',
  domain4 != null && domain4 >= n4Plonk && domain4 / 2 < n4Plonk,
  domain4 != null ? `${n4Plonk} Plonk -> domain ${domain4} (2^${need4}); ${domain4 / 2} would not hold it` : 'not derived');
console.log(`\n  ${'shape'.padEnd(24)}${'R1CS'.padStart(7)}${'Plonk'.padStart(8)}${'domain'.padStart(8)}${'ptau'.padStart(7)}`);
console.log(`  ${'portfoliogate  N=3'.padEnd(24)}${String(wideR1cs).padStart(7)}${String(wideFacts.nConstraints).padStart(8)}${String(wideFacts.domainSize).padStart(8)}${('2^' + wideFacts.ptauPower).padStart(7)}`);
console.log(`  ${'portfoliogate4 N=4'.padEnd(24)}${String(wide4R1cs).padStart(7)}${String(n4Plonk ?? '?').padStart(8)}${String(domain4 ?? "?").padStart(8)}${(need4 ? "2^" + need4 : "?").padStart(7)}   NOT BUILDABLE on disk`);
console.log(`  ${'portfolioleg   1 leg'.padEnd(24)}${String(legR1cs).padStart(7)}${String(legFacts.nConstraints).padStart(8)}${String(legFacts.domainSize).padStart(8)}${('2^' + legFacts.ptauPower).padStart(7)}`);

record('N=3 fills the domain it was fitted to', wideFacts.domainSize === 4096 && wideFacts.nConstraints > 3800,
  `${wideFacts.nConstraints} of ${wideFacts.domainSize} — ${wideFacts.domainSize - wideFacts.nConstraints} gates of slack`);
record('one leg on its own needs a SMALLER domain than the 3-leg circuit',
  legFacts.domainSize < wideFacts.domainSize, `${legFacts.domainSize} vs ${wideFacts.domainSize}`);

// The per-leg circuit is at FULL parity with liquidation.circom's widths, which three legs could not
// afford. That is a strictly wider input domain, and it is the second thing the shape change buys.
const wider = ['mHat', 'qHat', 'p0Hat', 'pLiqHat', 'refHat'].filter((k) => WIDE[k] > NARROW[k]);
record('the per-leg circuit accepts a STRICTLY WIDER input domain than the 3-leg circuit',
  wider.length === 5, `wider on ${wider.join(', ')} — e.g. price 2^60 vs 2^50, margin 2^80 vs 2^60`);

// ---- 2. the eleven-leg book, through the real engine -----------------------------------------------
// The largest book portfolio-gate's own tests exercise, and the size a three-leg circuit cannot
// describe at all. Same legs as gateB6, so the two gates are talking about one book.
const LEGS = [
  { side: 'long', entryPrice: 64000, size: 1.5, leverage: 10, maintMarginRate: 0.005 },
  { side: 'long', entryPrice: 3200, size: 20, leverage: 8, maintMarginRate: 0.006 },
  { side: 'short', entryPrice: 155, size: 400, leverage: 5, maintMarginRate: 0.01 },
  { side: 'long', entryPrice: 0.62, size: 90000, leverage: 4, maintMarginRate: 0.012 },
  { side: 'short', entryPrice: 7.4, size: 5000, leverage: 6, maintMarginRate: 0.009 },
  { side: 'long', entryPrice: 118, size: 300, leverage: 12, maintMarginRate: 0.007 },
  { side: 'long', entryPrice: 2.15, size: 15000, leverage: 3, maintMarginRate: 0.015 },
  { side: 'short', entryPrice: 42, size: 700, leverage: 7, maintMarginRate: 0.008 },
  { side: 'long', entryPrice: 9.8, size: 2500, leverage: 9, maintMarginRate: 0.011 },
  { side: 'short', entryPrice: 0.94, size: 40000, leverage: 4, maintMarginRate: 0.013 },
  { side: 'long', entryPrice: 320, size: 60, leverage: 15, maintMarginRate: 0.006 },
];

const builder = await makePerLegBuilder(import.meta.url);
const book = builder.build(LEGS);
record('the per-leg builder accepts the eleven-leg book whole', book.ok === true,
  book.ok ? `${book.legs.length} legs encoded · engine names leg ${book.nearest}` : `refused: ${book.why}`);
if (!book.ok) { console.log('\nCannot continue without an encoded book.'); await shutdown(); process.exit(1); }

// The wide route cannot even be ASKED about this book: its builder caps at three legs.
const wideTry = (await makeWideBuilder(import.meta.url)).build(LEGS);
record('the wide 3-leg route refuses this book outright, and says why', wideTry.ok === false,
  `${wideTry.why}`);

// ---- 3. prove every leg, and refuse a tampered signal ---------------------------------------------
const zkey = path.join(BUILD, 'portfolioleg_plonk.zkey');
const vk = JSON.parse(readFileSync(path.join(BUILD, 'portfolioleg_vk.json'), 'utf8'));
const legBuilder = await require(path.join(BUILD, 'portfolioleg_js', 'witness_calculator.cjs'))(
  readFileSync(path.join(BUILD, 'portfolioleg_js', 'portfolioleg.wasm')));

console.log('\nProving each leg on its own:');
const proofs = [];
let serialMs = 0, slowestMs = 0;
for (const leg of book.legs) {
  const wtns = await legBuilder.calculateWTNSBin(leg.witness, 0);
  const t = Date.now();
  const { proof, publicSignals } = await sj.plonk.prove(zkey, wtns);
  const ms = Date.now() - t;
  serialMs += ms; slowestMs = Math.max(slowestMs, ms);
  proofs.push({ leg, proof, publicSignals, ms });
}
console.log(`  ${proofs.length} legs proved · ${serialMs} ms serial · slowest single leg ${slowestMs} ms`);
record('every leg of the eleven produces a proof', proofs.length === book.legs.length,
  `${proofs.length} of ${book.legs.length} · median ${[...proofs.map((p) => p.ms)].sort((a, b) => a - b)[proofs.length >> 1]} ms`);

// THE PUBLIC SIGNAL LAYOUT IS CHECKED, NOT ASSUMED. The router reads d and refHat by index, and an
// index taken on faith is how gateB6 came to rank on the wrong field. So each index is tied back to
// the integer the encoder put in.
const D_INDEX = 2, REF_INDEX = 9;
const layoutOk = proofs.every(({ leg, publicSignals }) => publicSignals.length === 10
  && BigInt(publicSignals[D_INDEX]) === leg.d
  && BigInt(publicSignals[REF_INDEX]) === leg.refHat
  && BigInt(publicSignals[8]) === leg.pLiqHat);
record(`public signal ${D_INDEX} is the distance numerator and ${REF_INDEX} is the mark, verified against the encoder`,
  layoutOk, `10 signals: residual, tolerance, d, mHat, qHat, p0Hat, s, mmrHat, pLiqHat, refHat`);

// Off-chain refusal, on one leg, every signal moved on its own.
console.log('\nRefusals off chain — each public signal of leg 0 moved by one:');
const p0 = proofs[0];
record('the honest proof verifies against the published key',
  (await sj.plonk.verify(vk, p0.publicSignals, p0.proof)) === true, `${p0.ms} ms to prove`);
let offRefused = 0;
for (let i = 0; i < p0.publicSignals.length; i++) {
  const bad = [...p0.publicSignals];
  bad[i] = (BigInt(bad[i]) + 1n).toString();
  const accepted = await sj.plonk.verify(vk, bad, p0.proof);
  if (accepted === false) offRefused++;
  console.log(`  [${accepted === false ? 'PASS' : '*** FAIL ***'}] signal[${i}] + 1 -> ${accepted}`);
}
record('every perturbed public signal is rejected off chain', offRefused === p0.publicSignals.length,
  `${offRefused} of ${p0.publicSignals.length}`);

// ---- 3b. wall-clock, same process, same three legs -----------------------------------------------
// The wide circuit's proving time is quoted elsewhere from a run on another day. A comparison built on
// that is a comparison across two machine states, so both sides are measured HERE, on the same three
// legs, in this process. A 3-leg book is the largest the wide route can accept, so this is the only
// size at which the two routes can be compared at all.
const THREE = LEGS.slice(0, 3);
const wideBook = (await makeWideBuilder(import.meta.url)).build(THREE);
let wideProveMs = null, perLeg3Serial = null, perLeg3Parallel = null;
if (wideBook.ok) {
  const wideCalc = await require(path.join(BUILD, 'portfoliogate_js', 'witness_calculator.cjs'))(
    readFileSync(path.join(BUILD, 'portfoliogate_js', 'portfoliogate.wasm')));
  const wWtns = await wideCalc.calculateWTNSBin(wideBook.witness, 0);
  const wZkey = path.join(BUILD, 'portfoliogate_plonk.zkey');
  await sj.plonk.prove(wZkey, wWtns);                      // warm the key out of the measurement
  const t = Date.now();
  await sj.plonk.prove(wZkey, wWtns);
  wideProveMs = Date.now() - t;

  const three = builder.build(THREE);
  if (three.ok) {
    let ser = 0, slow = 0;
    for (const leg of three.legs) {
      const w = await legBuilder.calculateWTNSBin(leg.witness, 0);
      const t2 = Date.now();
      await sj.plonk.prove(zkey, w);
      const ms = Date.now() - t2;
      ser += ms; slow = Math.max(slow, ms);
    }
    perLeg3Serial = ser; perLeg3Parallel = slow;
  }
}
console.log(`\n  Same three legs, same process:`);
console.log(`    wide circuit, one proof at domain ${wideFacts.domainSize}   ${wideProveMs} ms`);
console.log(`    three per-leg proofs at domain ${legFacts.domainSize}   ${perLeg3Serial} ms serial · ~${perLeg3Parallel} ms parallel`);
record('one wide 3-leg proof is slower than three per-leg proofs run in parallel',
  wideProveMs != null && perLeg3Parallel != null && perLeg3Parallel < wideProveMs,
  `${wideProveMs} ms wide vs ~${perLeg3Parallel} ms per-leg parallel — the wide domain is 2x, and Plonk pays for the domain`);
// And the honest side of it: serial per-leg proving of the whole eleven-leg book is the slowest
// number here, so the parallel figure is a claim about a prover that actually runs legs in parallel.
record('the eleven-leg book costs more prover work in total than one wide 3-leg proof, and that is stated',
  serialMs > (wideProveMs ?? 0),
  `${serialMs} ms of prover work for 11 legs vs ${wideProveMs} ms for 3 — the parallel figure needs 11 workers`);

// ---- 4. THE FINDING: price-ranking and ratio-ranking name different legs --------------------------
const byRatio = book.legs.reduce((a, b) => (nearerThan(b, a) ? b : a));
const byPrice = book.legs.reduce((a, b) => (b.pLiqHat < a.pLiqHat ? b : a));
console.log(`\n  ranking on the distance RATIO  -> leg ${byRatio.index} (${byRatio.exactPct.toFixed(4)}% away, pLiq ${byRatio.certifiedPrice})`);
console.log(`  ranking on the liquidation PRICE -> leg ${byPrice.index} (${byPrice.exactPct.toFixed(4)}% away, pLiq ${byPrice.certifiedPrice})`);
record('the ratio ranking agrees with the leg the ENGINE named', byRatio.index === book.nearest,
  `engine named leg ${book.nearest}, cross-multiplied minimum names leg ${byRatio.index}`);
// This is the assertion that makes the gate able to fail for the right reason: if price-ranking
// happened to agree here, gateB6's router would be untested rather than wrong, and saying so would be
// a claim this book does not support.
record('price-ranking names a DIFFERENT leg, so gateB6 route B answered a different question',
  byPrice.index !== byRatio.index,
  `price picks leg ${byPrice.index} at ${byPrice.exactPct.toFixed(4)}% — not the binding leg`);

// ---- 5. on chain: verify n proofs, take the cross-multiplied minimum ------------------------------
const solc = (await import('solc')).default ?? (await import('solc'));
const { EVM } = await import('@ethereumjs/evm');
const { Common, Chain, Hardfork } = await import('@ethereumjs/common');
const { keccak256 } = await import('ethereum-cryptography/keccak.js');
const { utf8ToBytes, bytesToHex, hexToBytes } = await import('ethereum-cryptography/utils.js');

const NPUB = 10;
// REVERT MODE — a gate that cannot fail proves nothing, and this one's central claim is that the
// RATIO comparison is load-bearing. `B10_REVERT=price` swaps the router's comparison for gateB6's,
// ranking on the raw liquidation price, and the gate must then FAIL on the leg-identity check. Run:
//   B10_REVERT=price node zk/scripts/gateB10-portfolio-perleg.mjs   -> expect GATE B10: FAILED
const REVERT = process.env.B10_REVERT === 'price';
// pLiqHat is public signal 8. Ranking on it is a comparison of prices, not of distances.
const COMPARISON = REVERT
  ? 'signals[i][8] < signals[legIndex][8]'
  : 'd * refStar < dStar * r';
if (REVERT) console.log('  !! REVERT MODE: router ranks on the liquidation PRICE, as gateB6 did. The gate must fail.\n');
// The router re-derives NOTHING. Each proof already carries its own distance numerator and its own
// mark as public signals, bound by the circuit to the liquidation identity that was proven. The
// contract's whole job is to refuse any leg whose proof does not verify and then compare integers it
// was handed — by cross-multiplication, because d/ref is a ratio and comparing the numerators alone is
// the mistake gateB6 made. d and ref are each below 2^60 by an in-circuit range check, so each product
// is below 2^120 and a uint256 cannot overflow.
const ROUTER = `
// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.7.0 <0.9.0;
interface IVerifier { function verifyProof(uint256[24] calldata p, uint256[${NPUB}] calldata s) external view returns (bool); }
contract PortfolioNearestRatio {
    IVerifier public immutable verifier;
    uint256 public constant D_INDEX = ${D_INDEX};
    uint256 public constant REF_INDEX = ${REF_INDEX};
    constructor(address v) { verifier = IVerifier(v); }
    /// Verifies every leg, then returns the leg whose ADVERSE-MOVE distance d/ref is smallest.
    /// Reverts if ANY leg fails, because a portfolio minimum over a subset is not a minimum.
    function nearest(uint256[24][] calldata proofs, uint256[${NPUB}][] calldata signals)
        external view returns (uint256 legIndex, uint256 dStar, uint256 refStar)
    {
        require(proofs.length == signals.length && proofs.length > 0, "shape");
        for (uint256 i = 0; i < proofs.length; i++) {
            require(verifier.verifyProof(proofs[i], signals[i]), "leg proof invalid");
        }
        legIndex = 0;
        dStar = signals[0][D_INDEX];
        refStar = signals[0][REF_INDEX];
        for (uint256 i = 1; i < proofs.length; i++) {
            uint256 d = signals[i][D_INDEX];
            uint256 r = signals[i][REF_INDEX];
            // d/r < dStar/refStar  <=>  d*refStar < dStar*r. Strict, so the incumbent wins a tie,
            // which is the engine's tie-break: it scans with a strict < and keeps the EARLIER leg.
            if (${COMPARISON}) { legIndex = i; dStar = d; refStar = r; }
        }
    }
}
`;

const solOut = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'PortfoliolegVerifier.sol': { content: readFileSync(path.join(BUILD, 'PortfoliolegVerifier.sol'), 'utf8') },
    'PortfolioNearestRatio.sol': { content: ROUTER },
  },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})));
const solErrs = (solOut.errors || []).filter((e) => e.severity === 'error');
if (solErrs.length) throw new Error(solErrs.map((e) => e.formattedMessage).join('\n'));

const vKey = Object.keys(solOut.contracts['PortfoliolegVerifier.sol']).find((k) => /verifier/i.test(k) && !/^I[A-Z]/.test(k));
const V = solOut.contracts['PortfoliolegVerifier.sol'][vKey];
const R = solOut.contracts['PortfolioNearestRatio.sol'].PortfolioNearestRatio;

const caller = hexToBytes('1000000000000000000000000000000000000001');
async function freshEvm() {
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const dv = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
  if (dv.execResult.exceptionError) throw new Error(`verifier deploy: ${dv.execResult.exceptionError}`);
  const vAddr = bytesToHex(dv.createdAddress.bytes);
  const dr = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(R.evm.bytecode.object + vAddr.padStart(64, '0')), gasLimit: 30_000_000n });
  if (dr.execResult.exceptionError) throw new Error(`router deploy: ${dr.execResult.exceptionError}`);
  return { evm, rAddr: dr.createdAddress };
}

console.log(`\n  solc ${solc.version()} · verifier ${V.evm.deployedBytecode.object.length / 2} bytes · router ${R.evm.deployedBytecode.object.length / 2} bytes\n`);

const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const sel = bytesToHex(keccak256(utf8ToBytes(`nearest(uint256[24][],uint256[${NPUB}][])`))).slice(0, 8);
function encodeNearest(items) {
  const n = items.length;
  const offA = 64;
  const offB = 64 + 32 + n * 24 * 32;
  return hexToBytes(sel + pad(offA) + pad(offB)
    + pad(n) + items.flatMap((p) => p.words).map(pad).join('')
    + pad(n) + items.flatMap((p) => p.sigs).map(pad).join(''));
}

const prepared = [];
for (const p of proofs) {
  const raw = await sj.plonk.exportSolidityCallData(p.proof, p.publicSignals);
  const [words, sigs] = JSON.parse(`[${raw.replace(/\]\s*\[/g, '],[')}]`);
  prepared.push({ words, sigs, index: p.leg.index, leg: p.leg });
}

// Each row in a FRESH EVM. Sharing one instance makes every row after the first 7,500 gas cheaper for
// free (EIP-2929 cold/warm), which would flatter the per-leg curve exactly where it is being judged.
console.log('Verify n proofs and take the cross-multiplied minimum, one call, fresh EVM per row:');
console.log(`  ${'legs'.padStart(5)}${'gas'.padStart(12)}${'gas/leg'.padStart(10)}`);
const rows = [];
for (const n of [1, 3, 4, 6, 8, prepared.length]) {
  if (n > prepared.length) continue;
  const { evm, rAddr } = await freshEvm();
  const res = await evm.runCall({ caller: { bytes: caller }, to: rAddr, data: encodeNearest(prepared.slice(0, n)), gasLimit: 120_000_000n });
  if (res.execResult.exceptionError) { console.log(`  ${String(n).padStart(5)}  reverted: ${JSON.stringify(res.execResult.exceptionError)}`); continue; }
  const gas = res.execResult.executionGasUsed;
  rows.push({ n, gas });
  console.log(`  ${String(n).padStart(5)}${String(gas).padStart(12)}${String(gas / BigInt(n)).padStart(10)}`);
}
record('the router scales to eleven legs in one call', rows.some((r) => r.n === prepared.length),
  rows.length ? `${rows[rows.length - 1].n} legs · ${rows[rows.length - 1].gas} gas` : 'no row completed');

// The answer has to be RIGHT, not merely cheap.
{
  const { evm, rAddr } = await freshEvm();
  const full = await evm.runCall({ caller: { bytes: caller }, to: rAddr, data: encodeNearest(prepared), gasLimit: 120_000_000n });
  const ret = bytesToHex(full.execResult.returnValue);
  const onChainIdx = Number(BigInt('0x' + ret.slice(0, 64)));
  const onChainD = BigInt('0x' + ret.slice(64, 128));
  const onChainRef = BigInt('0x' + ret.slice(128, 192));
  const expectedSlot = prepared.findIndex((p) => p.index === book.nearest);
  record('the contract names the leg the ENGINE named, ranking by ratio on chain',
    onChainIdx === expectedSlot && onChainD === byRatio.d && onChainRef === byRatio.refHat,
    `slot ${onChainIdx} = book leg ${prepared[onChainIdx]?.index} · d/ref = ${(Number(onChainD) / Number(onChainRef) * 100).toFixed(4)}%`);
}

// And the halves that can fail.
{
  const { evm, rAddr } = await freshEvm();
  const bent = prepared.map((p, i) => (i === 2
    ? { ...p, words: ['0x' + (BigInt(p.words[0]) + 1n).toString(16), ...p.words.slice(1)] } : p));
  const res = await evm.runCall({ caller: { bytes: caller }, to: rAddr, data: encodeNearest(bent), gasLimit: 120_000_000n });
  record('one bent proof point sinks the whole answer', !!res.execResult.exceptionError,
    res.execResult.exceptionError ? `reverted: ${res.execResult.exceptionError}` : 'ACCEPTED A BAD LEG');
}
{
  // The attack the ratio router must specifically stop: move the DISTANCE on a safe leg so it claims
  // to be the nearest. The proof no longer matches its signals, so the verify fails and nothing else
  // in the contract gets a chance to be fooled.
  const { evm, rAddr } = await freshEvm();
  const victim = prepared.findIndex((p) => p.index !== book.nearest);
  const tampered = prepared.map((p, i) => (i === victim
    ? { ...p, sigs: p.sigs.map((s, j) => (j === D_INDEX ? '0x1' : s)) } : p));
  const res = await evm.runCall({ caller: { bytes: caller }, to: rAddr, data: encodeNearest(tampered), gasLimit: 120_000_000n });
  record('a tampered DISTANCE signal is refused rather than winning the ranking',
    !!res.execResult.exceptionError,
    res.execResult.exceptionError ? `leg ${prepared[victim].index} claimed d=1 · reverted: ${res.execResult.exceptionError}` : 'ACCEPTED A FORGED DISTANCE');
}

// ---- 6. how often is a leg refused, at 4, 6 and 11 legs ------------------------------------------
// The wide route's answer is 100% at every size above three, by construction. What is worth measuring
// is the per-leg route's own refusal rate, and how much of it the WIDER bounds buy back.
console.log('\nRefusal rate over synthetic books — encodability only, no proving:');
let seed = 20260730;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const PRICES = [64000, 3200, 155, 0.62, 7.4, 118, 2.15, 42, 9.8, 0.94, 320, 1.0004, 0.00031, 118000];
function randomLeg() {
  const entryPrice = pick(PRICES) * (0.5 + rnd());
  return {
    side: rnd() < 0.5 ? 'long' : 'short',
    entryPrice: Number(entryPrice.toFixed(9)),
    size: Number((10 / entryPrice * (1 + 40 * rnd())).toFixed(9)),
    leverage: Math.max(2, Math.round(2 + 18 * rnd())),
    maintMarginRate: Number((0.004 + 0.012 * rnd()).toFixed(9)),
  };
}
const BOOKS = 200;
const sweep = [];
for (const n of [4, 6, 11]) {
  let accepted = 0, refusedLegs = 0, splits = 0, engineNo = 0, totalLegs = 0;
  const reasons = {};
  for (let b = 0; b < BOOKS; b++) {
    const bk = Array.from({ length: n }, randomLeg);
    const r = builder.build(bk);
    totalLegs += n;
    if (r.ok) { accepted++; continue; }
    if (r.orderingSplit) { splits++; reasons.orderingSplit = (reasons.orderingSplit || 0) + 1; continue; }
    if (r.refused) {
      refusedLegs += r.refused.length;
      for (const x of r.refused) { const k = x.bound ? `bound:${x.bound}` : (x.breached ? 'breached' : (x.divergedPct ? 'divergedPct' : (x.divergedPrice ? 'divergedPrice' : 'other'))); reasons[k] = (reasons[k] || 0) + 1; }
      continue;
    }
    engineNo++; reasons[r.why] = (reasons[r.why] || 0) + 1;
  }
  sweep.push({ legs: n, books: BOOKS, accepted, acceptedPct: +(100 * accepted / BOOKS).toFixed(1), refusedLegs, totalLegs, orderingSplits: splits, reasons });
  console.log(`  ${String(n).padStart(2)} legs: ${String(accepted).padStart(3)}/${BOOKS} books accepted (${(100 * accepted / BOOKS).toFixed(1)}%) · ${refusedLegs} of ${totalLegs} legs refused · ${splits} ordering splits`);
  console.log(`           reasons: ${Object.entries(reasons).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
}
record('books of 4, 6 and 11 legs are accepted at every size the wide route cannot reach at all',
  sweep.every((s) => s.accepted > 0), sweep.map((s) => `${s.legs}:${s.acceptedPct}%`).join('  '));

// ---- 7. the comparison ---------------------------------------------------------------------------
const ROUTE_A_GAS = readGas('gateB8-2-portfolio-evm', 'acceptGas', 'the wide 3-leg portfolio verifier, all legs in one proof');
const full11 = rows.find((r) => r.n === prepared.length);
const perLegProve = Math.round(serialMs / proofs.length);

console.log(`\n${'-'.repeat(72)}`);
console.log(`For an ${prepared.length}-leg book:\n`);
console.log(`  WIDE CIRCUIT (one proof)`);
console.log(`    gas        ~${ROUTE_A_GAS} for THREE legs  (${GAS_VARIANCE_NOTE})`);
console.log(`    ceiling    3 legs. N=4 is ${n4Plonk} Plonk and needs 2^${need4}; the ceremony on disk is 2^12.`);
console.log(`    domain     narrowed to fit: price 2^50, size 2^55, margin 2^60`);
console.log(`\n  PER-LEG + ON-CHAIN RATIO MINIMUM`);
console.log(`    gas        ${full11 ? full11.gas : '?'} for ${prepared.length} legs${full11 ? ` (${(Number(full11.gas) / Number(ROUTE_A_GAS)).toFixed(1)}x the 3-leg wide verify)` : ''}`);
console.log(`    proving    ${perLegProve} ms per leg · ${serialMs} ms serial · ~${slowestMs} ms if legs run in parallel`);
console.log(`    ceiling    none. ${legFacts.nConstraints} Plonk at domain ${legFacts.domainSize} — a 2^11 ceremony would do.`);
console.log(`    domain     full parity with liquidation.circom: price 2^60, size 2^60, margin 2^80`);

record('the shape change removes the ceiling rather than raising it',
  legFacts.domainSize <= 2048 && rows.some((r) => r.n > 3),
  `${prepared.length} legs proved and verified with the ceremony file already on disk — no download`);

const bad = failed();
const gate = bad.length === 0;
console.log(`\n${'='.repeat(72)}`);
console.log(`GATE B10: ${gate ? 'PASSED' : `FAILED — ${bad.map((x) => x.name).join('; ')}`}`);
console.log('  NOTHING DEPLOYED. PortfolioNearestRatio.sol exists only inside this test.');

writeFileSync(path.join(BUILD, 'gateB10-portfolio-perleg.json'), JSON.stringify({
  at: new Date().toISOString(), passed: gate, legs: prepared.length,
  ceiling: {
    wideN3: { r1cs: wideR1cs, plonk: wideFacts.nConstraints, domain: wideFacts.domainSize },
    wideN4: { r1cs: wide4R1cs, plonk: n4Plonk, domainNeeded: need4 ? 2 ** need4 : null, ptauNeeded: need4 ? `2^${need4}` : null, buildableOnDisk: false },
    perLeg: { r1cs: legR1cs, plonk: legFacts.nConstraints, domain: legFacts.domainSize, ptauSufficient: `2^${legFacts.ptauPower}` },
  },
  ranking: { engineNamed: book.nearest, byRatio: byRatio.index, byPrice: byPrice.index, priceRankingIsWrong: byPrice.index !== byRatio.index },
  perLeg: { gas: full11 ? String(full11.gas) : null, proveMsPerLeg: perLegProve, proveMsSerial: serialMs, proveMsParallel: slowestMs },
  sameProcessThreeLegs: { wideOneProofMs: wideProveMs, perLegSerialMs: perLeg3Serial, perLegParallelMs: perLeg3Parallel },
  wide3LegVerifyGas: String(ROUTE_A_GAS),
  gasByLegCount: rows.map((r) => ({ legs: r.n, gas: String(r.gas) })),
  refusalSweep: sweep,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(gate ? 0 : 1);
