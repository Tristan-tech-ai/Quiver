// GATE A1 — a Solidity view that returns HyperCore's mark, on HyperEVM, for every asset.
//
// Done means: the contract's answer equals the off-chain read for EVERY asset in the universe, and it
// REVERTS rather than returning zero where the precompile has no answer.
//
// The contract is not deployed here. It is planted at an address with an `eth_call` state override on
// chain 999 and executed by a real HyperEVM node, so the value it reads is HyperCore's committed state
// at that block rather than a fixture. That is the whole point: read off chain, both the HTTP value
// and the precompile value cross the same wire and one adversary sees both. Read INSIDE the EVM, the
// precompile value comes from consensus.
//
// Run: node zk/scripts/gateA1-precompile-view.mjs
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILD, CONTRACTS, RPCS, PRECOMPILES, rpc, precompile, u32, decodePerpAssetInfo, perpUniverse,
  compile, readSol, runtimeCodeFor, abiWords, selector, callPlantedRaw, namedRevert, checklist, gridMul,
} from './lib/perpkit.mjs';

const g = checklist();
console.log(`GATE A1 — the precompile read, in Solidity, on chain 999 — ${new Date().toISOString()}\n`);

// ── compile ───────────────────────────────────────────────────────────────────────────────────────
const SRC = path.join(CONTRACTS, 'QuiverPerpVerifier.sol');
const Q = compile('QuiverPerpVerifier.sol', 'QuiverPerpVerifier', {
  'QuiverPerpVerifier.sol': { content: readSol(SRC) },
});
console.log(`  solc ${Q.solc} · creation ${Q.evm.bytecode.object.length / 2} bytes · runtime ${Q.evm.deployedBytecode.object.length / 2} bytes`);

// A1 needs no real verifier, but the constructor refuses address(0), which is itself worth keeping.
const PLACEHOLDER_VERIFIER = '0x00000000000000000000000000000000000000ff';
const { code: runtime } = await runtimeCodeFor(Q.evm.bytecode.object, abiWords(PLACEHOLDER_VERIFIER, 0, 1));
const AT = '0x00000000000000000000000000000000000A0A01';
const overrides = { [AT]: { code: runtime } };
console.log(`  runtime with immutables baked: ${(runtime.length - 2) / 2} bytes, planted at ${AT}\n`);

const SEL = {
  markPxRaw: await selector('markPxRaw(uint32)'),
  szDecimals: await selector('szDecimals(uint32)'),
  markPxHat: await selector('markPxHat(uint32)'),
  markProvenance: await selector('markProvenance(uint32)'),
  marksHat: await selector('marksHat(uint32[])'),
};
const ERRS = [
  'PrecompileUnavailable(address,uint32)',
  'PrecompileShortReturn(address,uint32,uint256)',
  'ImplausibleSzDecimals(uint32,uint256)',
];

const call = (sel, arg) => callPlantedRaw({ to: AT, data: sel + u32(arg), overrides });

// ── 1. the chain and the block everything below is read at ────────────────────────────────────────
const chainId = Number(BigInt(await rpc('eth_chainId', [])));
const blockHex = await rpc('eth_blockNumber', []);
g.record('running against chain 999', chainId === 999, `chainId ${chainId} · block ${BigInt(blockHex)}`);

// ── 2. THE PRECOMPILES ARE NOT BLOCK-SCOPED. Measured here, because it changes what A2 can claim ───
//
// The build plan says the join reads "the mark from the HyperCore precompile AT THIS BLOCK". Inside a
// TRANSACTION that is true — the read is part of that block's execution and consensus commits to it.
// But `eth_call` at an explicit block tag does NOT reproduce the value that block held: the precompile
// answers with CURRENT HyperCore state whatever tag is passed. This was checked rather than assumed —
// a tag from 5.5 hours ago tracked `latest` in lock-step across six samples while the price moved.
//
// Two consequences, both real:
//   · a past join cannot be re-verified by replaying `eth_call` at the historical block. The evidence
//     that a mark held is the TRANSACTION's own inclusion, not a simulation anyone can repeat.
//   · one of the three public RPCs (purroofgroup) reverts on ANY explicit block tag, so pinning a
//     block is not even portable. This gate therefore reads at `latest` and brackets instead.
const bnA = BigInt(await rpc('eth_blockNumber', [], { rpcs: [RPCS[0]] }));
const oldTag = '0x' + (bnA - 20000n).toString(16);
const pairs = [];
for (let i = 0; i < 4; i++) {
  const [l, o] = await Promise.all([
    rpc('eth_call', [{ to: PRECOMPILES.markPx, data: '0x' + u32(0) }, 'latest'], { rpcs: [RPCS[0]] }),
    rpc('eth_call', [{ to: PRECOMPILES.markPx, data: '0x' + u32(0) }, oldTag], { rpcs: [RPCS[0]] }),
  ]);
  pairs.push([BigInt(l), BigInt(o)]);
  if (i < 3) await new Promise((s) => setTimeout(s, 6000));
}
const tracks = pairs.every(([l, o]) => l === o);
const moved = new Set(pairs.map(([l]) => String(l))).size > 1;
g.record('the precompile is NOT block-scoped: a 20,000-block-old tag tracks `latest`', tracks && moved,
  `${pairs.map(([l, o]) => `${l}/${o}`).join('  ')} — ${moved ? 'the price moved during the sample, and the old tag moved with it' : 'the price did not move, so this sample proves nothing; rerun'}`);

// ── 3. every asset, contract vs direct precompile, bracketed ──────────────────────────────────────
// Because there is no block to pin against, the contract read and the direct read cannot be made
// simultaneous. So the direct reads are BRACKETED by two contract batches and each must match one end.
// A decode bug cannot hide inside a bracket; only real movement can.
const universe = await perpUniverse();
console.log(`  perp universe: ${universe.length} assets\n`);

const indices = universe.map((u) => u.perpIndex);
const CH = 100;   // 232 assets in one call needs more than the 2,000,000-gas small-block cap; 100 fits.
const offHats = new Map();
const szOff = new Map();

async function contractBatchAll() {
  const out = new Map();
  for (let i = 0; i < indices.length; i += CH) {
    const batch = indices.slice(i, i + CH);
    // ONE eth_call returns every mark in the batch at ONE moment — inter-asset skew removed.
    const arr = '0x' + SEL.marksHat.slice(2)
      + (32).toString(16).padStart(64, '0')
      + batch.length.toString(16).padStart(64, '0')
      + batch.map((b) => u32(b)).join('');
    const r = await callPlantedRaw({ to: AT, data: arr, overrides });
    if (!r.ok) throw new Error(`marksHat batch failed: ${JSON.stringify(r.error).slice(0, 220)}`);
    const h = r.result.replace(/^0x/, '');
    const w = (k) => BigInt('0x' + h.slice(k * 64, k * 64 + 64));
    if (Number(w(3)) !== batch.length) throw new Error(`marksHat returned ${Number(w(3))} values for ${batch.length} assets`);
    batch.forEach((b, k) => out.set(b, w(4 + k)));
  }
  return out;
}

const before = await contractBatchAll();
process.stdout.write('  contract batch A done · direct reads ');
for (let i = 0; i < indices.length; i += CH) {
  const batch = indices.slice(i, i + CH);
  await Promise.all(batch.map(async (b) => {
    const [m, info] = await Promise.all([
      rpc('eth_call', [{ to: PRECOMPILES.markPx, data: '0x' + u32(b) }, 'latest']),
      rpc('eth_call', [{ to: PRECOMPILES.perpAssetInfo, data: '0x' + u32(b) }, 'latest']),
    ]);
    const sz = decodePerpAssetInfo(info).szDecimals;
    szOff.set(b, sz);
    offHats.set(b, BigInt(m) * gridMul(sz));
  }));
  process.stdout.write(`${Math.min(i + CH, indices.length)} `);
}
const after = await contractBatchAll();
console.log('· contract batch B done\n');

let agree = 0; let bracketed = 0; const disagree = [];
for (const b of indices) {
  const off = offHats.get(b);
  const lo = before.get(b) < after.get(b) ? before.get(b) : after.get(b);
  const hi = before.get(b) < after.get(b) ? after.get(b) : before.get(b);
  if (before.get(b) === off) agree++;
  if (off >= lo && off <= hi) bracketed++;
  else disagree.push({ asset: b, name: universe[b].name, before: String(before.get(b)), direct: String(off), after: String(after.get(b)) });
}
// The wide bracket is a screen, not a verdict. 232 direct reads take well over a minute and a mark
// turns over about once a second, so a price that wanders non-monotonically between batch A and batch
// B leaves its own reading outside [A,B] with nothing wrong. Every asset the screen flags is therefore
// re-read TIGHTLY — contract, direct, contract, back to back on one asset — where the bracket is
// hundreds of milliseconds wide and a disagreement really is a disagreement.
console.log(`  wide screen: ${bracketed}/${indices.length} · re-reading ${disagree.length} tightly`);
const stillBad = [];
for (const d of disagree) {
  const b = d.asset;
  const c1 = await callPlantedRaw({ to: AT, data: SEL.markPxHat + u32(b), overrides });
  const dir = await rpc('eth_call', [{ to: PRECOMPILES.markPx, data: '0x' + u32(b) }, 'latest']);
  const c2 = await callPlantedRaw({ to: AT, data: SEL.markPxHat + u32(b), overrides });
  const dHat = BigInt(dir) * gridMul(szOff.get(b));
  const v1 = BigInt(c1.result), v2 = BigInt(c2.result);
  const lo = v1 < v2 ? v1 : v2, hi = v1 < v2 ? v2 : v1;
  if (!(dHat >= lo && dHat <= hi)) stillBad.push({ ...d, tight: [String(v1), String(dHat), String(v2)] });
}
g.record('every asset: the contract\'s integer agrees with a direct precompile read',
  stillBad.length === 0,
  `${bracketed}/${indices.length} inside the wide bracket · ${agree}/${indices.length} equalled batch A outright`
  + ` · ${disagree.length} re-read tightly, ${disagree.length - stillBad.length} agreed`
  + (stillBad.length ? `\n           still disagreeing: ${JSON.stringify(stillBad.slice(0, 3))}` : ''));

// ── 3b. THE DECODE, WITH NO TIMING IN IT ──────────────────────────────────────────────────────────
// The bracket above cannot separate "the decode is wrong" from "the price moved", because a HyperCore
// mark turns over about once a second and 232 direct reads take longer than that. So the decode is
// checked against the RAW BYTES THE PRECOMPILE RETURNED IN THE SAME CALL. Nothing can move in between.
console.log('  decode check, contract return bytes vs contract derived value:');
let exact = 0; const decodeBad = [];
for (const b of indices) {
  const r = await callPlantedRaw({ to: AT, data: SEL.markProvenance + u32(b), overrides });
  if (!r.ok) { decodeBad.push({ asset: b, name: universe[b].name, err: 'reverted' }); continue; }
  const h = r.result.replace(/^0x/, '');
  const w = (k) => BigInt('0x' + h.slice(k * 64, k * 64 + 64));
  // (bytes markRet, bytes infoRet, uint64 raw, uint8 sz, uint256 hat)
  const markOff = Number(w(0)) / 32, infoOff = Number(w(1)) / 32;
  const rawWord = w(2), szWord = Number(w(3)), hatWord = w(4);
  const markBytes = '0x' + h.slice((markOff + 1) * 64, (markOff + 1) * 64 + 64);
  const infoLen = Number(w(infoOff));
  const infoBytes = '0x' + h.slice((infoOff + 1) * 64, (infoOff + 1) * 64 + infoLen * 2);
  const szIndependent = decodePerpAssetInfo(infoBytes).szDecimals;
  const rawIndependent = BigInt(markBytes);
  const hatIndependent = rawIndependent * gridMul(szIndependent);
  if (rawIndependent === rawWord && szIndependent === szWord && hatIndependent === hatWord) exact++;
  else decodeBad.push({ asset: b, name: universe[b].name, raw: [String(rawIndependent), String(rawWord)], sz: [szIndependent, szWord], hat: [String(hatIndependent), String(hatWord)] });
  if (b % 40 === 39) process.stdout.write(`${b + 1} `);
}
console.log('');
g.record('the on-chain decode and the 1e9 scaling are EXACT for every asset, checked against the bytes the precompile returned in the same call',
  exact === indices.length && decodeBad.length === 0,
  `${exact}/${indices.length} exact` + (decodeBad.length ? `\n           wrong: ${JSON.stringify(decodeBad.slice(0, 3))}` : ''));

// ── 3. the negative: it must REVERT, not return zero ──────────────────────────────────────────────
// This is the half that can fail. A view that returns 0 for an unknown asset would make markPxHat
// return 0, and `verifyPerpGate` would then compare a proven price against zero and refuse everything
// — or, with the comparison written the other way round, accept everything.
console.log('\nRefusals — an asset the precompile has no answer for:');
const BAD = [232, 300, 9999, 100000, 4294967295];
let reverted = 0;
for (const b of BAD) {
  const r = await call(SEL.markPxHat, b);
  const named = r.ok ? null : await namedRevert(r.data, ERRS);
  const isRevert = !r.ok;
  const zero = r.ok && BigInt(r.result || '0x0') === 0n;
  if (isRevert) reverted++;
  console.log(`  [${isRevert ? 'PASS' : '*** FAIL ***'}] markPxHat(${String(b).padEnd(10)}) ${isRevert ? `reverted ${named}` : `RETURNED ${r.result}${zero ? ' (ZERO — the exact failure this checks for)' : ''}`}`);
}
g.record('an asset with no answer REVERTS rather than returning zero', reverted === BAD.length,
  `${reverted}/${BAD.length}`);

// And the same for the raw read and for szDecimals, so the revert is not an accident of one path.
const rawBad = await call(SEL.markPxRaw, 99999);
const szBad = await call(SEL.szDecimals, 99999);
g.record('markPxRaw and szDecimals revert on the same input', !rawBad.ok && !szBad.ok,
  `markPxRaw ${rawBad.ok ? 'RETURNED ' + rawBad.result : 'reverted'} · szDecimals ${szBad.ok ? 'RETURNED ' + szBad.result : 'reverted'}`);

// No asset the precompile DOES answer for carries a zero mark. If one did, `allowedDeviationHat` would
// be sizing a window against nothing and every near-zero p0Hat would pass, so the contract reverts on a
// zero — this asks the separate question of whether that path is reachable at all in the live universe.
const zeros = indices.filter((b) => before.get(b) === 0n || after.get(b) === 0n);
g.record('no asset the precompile answers for carries a zero mark', zeros.length === 0,
  zeros.length ? `zero mark on ${zeros.map((b) => `${b}:${universe[b].name}`).join(', ')}` : `0 of ${indices.length}`);

// A valid asset still works after all that, so the revert is about the input and not about the plant.
const good = await call(SEL.markPxHat, 0);
g.record('a valid asset still answers', good.ok && BigInt(good.result) > 0n,
  `markPxHat(0) = ${good.ok ? BigInt(good.result) : 'reverted'} (${good.ok ? Number(BigInt(good.result)) / 1e9 : '-'} on the 1e9 grid)`);

// ── 4. cost ───────────────────────────────────────────────────────────────────────────────────────
const est = await rpc('eth_estimateGas', [{ from: '0x000000000000000000000000000000000000dEaD', to: AT, data: SEL.markPxHat + u32(0), gas: '0x1D4C00' }, 'latest', overrides]);
console.log(`\n  eth_estimateGas for markPxHat(0) through the contract: ${BigInt(est)} gas (two precompile reads + dispatch)`);

const failed = g.failed();
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE A1: ${failed.length === 0 ? 'PASSED' : `FAILED — ${failed.map((f) => f.name).join('; ')}`}`);

fs.writeFileSync(path.join(BUILD, 'gateA1-precompile-view.json'), JSON.stringify({
  at: new Date().toISOString(), passed: failed.length === 0, chainId, block: String(BigInt(blockHex)),
  solc: Q.solc, runtimeBytes: (runtime.length - 2) / 2, assets: indices.length, exactAgreement: agree,
  revertedOnUnknown: reverted, markPxHatGas: String(BigInt(est)), checks: g.results,
}, null, 2) + '\n', 'utf8');
process.exit(failed.length === 0 ? 0 : 1);
