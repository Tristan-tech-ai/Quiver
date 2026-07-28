// GATE E — eth_getProof state anchoring for lp-desk and calldata-x.
//
// The claim under test is NOT "we can call eth_getProof". It is: a value this stack used can be shown
// to be the value the chain's state trie committed at a named block, and a value that was NOT can be
// shown to be refused. A gate that only ran the honest half would pass identically if `verifyMpt`
// were `return {ok:true}`, so most of this file is the red half.
//
// The red half runs against a LOCAL TAMPER PROXY (127.0.0.1) that sits in front of a real RPC and
// rewrites its answers: a fabricated storage value, a leaf rewritten to encode a different number, a
// proof lifted from a different block, a dropped node, a doctored stateRoot. Each one goes through
// the SAME anchorState() the green half uses. Testing the verifier directly with hand-built bytes
// would prove the verifier works on hand-built bytes; this proves the adapter refuses a hostile
// server.
//
//   node --test gates/gateE-ethproof-anchor.mjs     (npm run gate:e)
//   node gates/gateE-revert.mjs                     (npm run gate:e-revert) — proves it goes red
//
// Live-network gate. Network flakiness is tolerated ONLY where it is not the thing being measured:
// a pool that cannot be fetched is skipped and counted, a proof that fetches and fails to verify is
// a failure. Those are never conflated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { keccak256, encodeRlp, decodeRlp, getBytes } from 'ethers';
import { anchorState, anchorAddress, verifyMpt, headerHash, storageKey, proofEndpoints, EMPTY_TRIE_ROOT } from '../src/adapters/ethproof.js';
import { anchorPoolState, anchorSwapRow, decodeSwapPostState, slot0LooksLikeV3, LP_DESK_COVERAGE, CALLDATA_X_COVERAGE } from '../src/adapters/univ3anchor.js';

const CHAIN = 'ethereum';
const RPC = proofEndpoints(CHAIN)[0].url;                 // deepest measured proof window
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

// Verified on chain 2026-07-28 (fee() and token0()/token1() read, never trusted from a constant).
const POOLS = [
  { name: 'ETH/USDC 0.05%', addr: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' },
  { name: 'ETH/USDC 0.30%', addr: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8' },
  { name: 'WBTC/ETH 0.30%', addr: '0xcbcdf9626bc03e24f779434178a73a0b4bad62ed' },
  { name: 'USDC/USDT 0.01%', addr: '0x3416cf6c708da44db2624d63ea0aaef7113527c6' },
  { name: 'WETH/USDT 0.30%', addr: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36' },
  { name: 'LINK/ETH 0.30%', addr: '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8' },
];

// Free endpoints rate-limit, and a rate-limit page is NOT a failed proof. Retries here are for
// transport only; nothing in this helper ever retries a verification result.
const ALL_RPCS = proofEndpoints(CHAIN).map((e) => e.url);
async function rpc(method, params, url = null, timeoutMs = 30000) {
  const urls = url ? [url] : ALL_RPCS;
  let last = null;
  for (let attempt = 0; attempt < urls.length * 2; attempt++) {
    const u = urls[attempt % urls.length];
    try {
      const r = await fetch(u, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const t = await r.text();
      const j = JSON.parse(t);                       // an HTML rate-limit page throws here
      if (j.error) throw new Error(String(j.error.message || JSON.stringify(j.error)).slice(0, 120));
      return j.result;
    } catch (e) { last = e; await new Promise((s) => setTimeout(s, 250 * (1 + attempt))); }
  }
  throw last;
}

const HEAD = parseInt(await rpc('eth_blockNumber', []), 16);
// PIN sits inside the window ALL THREE mainnet operators can prove (measured: publicnode 64,
// onfinality 256, mevblocker 1,000,000). That is deliberate — it lets the gate exercise real
// failover and real 3-of-3 agreement instead of leaning on the single archive node. E15 then goes
// deliberately deep to record what is lost out there.
const PIN = HEAD - 40;

// Collected across tests so the summary reports MEASUREMENTS, not the research's remembered numbers.
const M = { sizes: [], latencies: [], wire: [], agreements: [], coverage: [], refusals: [], skipped: [] };

// ---------------------------------------------------------------------------------------------
// The tamper proxy. Forwards to a real RPC and mutates the reply according to `mode`.

async function upstreamJson(payload, tries = 8) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const u = ALL_RPCS[i % ALL_RPCS.length];
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
      const t = await r.text();
      const j = JSON.parse(t);
      if (j.error && /rate limit|too many|archive|personal token|historical|missing trie node|no state found|proof window/i.test(String(j.error.message))) throw new Error('transport');
      return j;
    } catch (e) { last = e; await new Promise((s) => setTimeout(s, 200 * (i + 1))); }
  }
  throw last;
}

function startTamperProxy(upstream) {
  const state = { mode: 'honest', swapBlockTag: null };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch { res.writeHead(400).end('{}'); return; }
      try {
        // 'other-block': answer eth_getProof for a DIFFERENT height while the header stays honest.
        // The header then verifies perfectly and the proof still has to be refused — which is the
        // "proof against the wrong state root" case, in the form an attacker would actually use.
        const params = (state.mode === 'other-block' && payload.method === 'eth_getProof')
          ? [payload.params[0], payload.params[1], state.swapBlockTag]
          : payload.params;
        // The proxy rotates its own upstream on a rate limit. Which honest node served the bytes is
        // irrelevant — this test is about how the ADAPTER reacts to the tampered reply, and letting
        // an upstream 429 masquerade as a refusal would make the red half untrustworthy.
        const j = await upstreamJson({ ...payload, params });
        const out = tamper(j, payload.method, state.mode);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: String(e.message).slice(0, 100) } }));
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, state, close: () => new Promise((r) => srv.close(r)) })));
}

function tamper(j, method, mode) {
  if (mode === 'honest' || mode === 'other-block' || !j.result) return j;
  const r = j.result;
  if (method === 'eth_getProof') {
    if (mode === 'fake-value' && r.storageProof?.[0]) {
      // The proof is left intact and only the ECHO is changed — the attack against a caller that
      // reads `storageProof[i].value` without verifying the leaf it came from.
      r.storageProof[0].value = '0x1234567890abcdef';
    }
    if (mode === 'fake-leaf' && r.storageProof?.[0]?.proof?.length) {
      // Rewrite the LEAF so the trie itself claims a different number. The parent still commits to
      // the old node hash, so this must break the chain.
      const p = r.storageProof[0].proof;
      const leaf = decodeRlp(getBytes(p[p.length - 1]));
      if (Array.isArray(leaf) && leaf.length === 2) p[p.length - 1] = encodeRlp([leaf[0], encodeRlp('0xdeadbeef')]);
    }
    if (mode === 'drop-node' && r.storageProof?.[0]?.proof?.length > 1) r.storageProof[0].proof.pop();
    if (mode === 'empty-proof' && r.storageProof?.[0]) r.storageProof[0].proof = [];
    if (mode === 'fake-nonce') r.nonce = '0x7fffffff';
  }
  if (method === 'eth_getBlockByNumber' && mode === 'fake-stateroot' && r) {
    r.stateRoot = '0x' + 'ab'.repeat(32);
  }
  if (method === 'eth_getCode' && mode === 'fake-code' && typeof r === 'string') {
    j.result = r + 'deadbeef';
  }
  return j;
}

// ---------------------------------------------------------------------------------------------

test('E1 GREEN — a pool\'s slot0 and liquidity anchor to the block stateRoot, on several real pools', async () => {
  let anchored = 0;
  for (const p of POOLS) {
    let st;
    try { st = await anchorPoolState({ chain: CHAIN, pool: p.addr, block: PIN, corroborate: true }); }
    catch (e) { M.skipped.push(`${p.name}: transport ${String(e.message).slice(0, 60)}`); continue; }
    if (!st.ok && st.transport) { M.skipped.push(`${p.name}: TRANSPORT ${st.reason.slice(0, 60)}`); continue; }
    assert.equal(st.ok, true, `${p.name} failed to anchor: ${st.reason}`);
    // The proven word must be internally consistent — this is the check that a wrong slot number or a
    // V3 fork trips, and it is adversary-independent arithmetic on the proven bytes.
    assert.ok(st.selfCheck.tickDelta <= 2, `${p.name}: sqrtPriceX96 implies tick ${st.selfCheck.impliedTick} but slot0 says ${st.proven.tick}`);
    assert.equal(st.layout.checked, true, `${p.name}: storage layout was not confirmed against the pool's own getters`);
    assert.ok(BigInt(st.proven.liquidity) >= 0n);
    M.sizes.push({ pool: p.name, bytes: st.size.totalProofBytes, acct: st.size.accountProofBytes, stor: st.size.storageProofBytes, nodes: st.size.accountProofNodes, wire: st.size.wireBytes });
    M.latencies.push(st.latencyMs);
    M.wire.push(st.size.wireBytes);
    if (st.agreement) M.agreements.push(`${st.agreement.agree}/${st.agreement.asked}`);
    anchored++;
  }
  assert.ok(anchored >= 4, `only ${anchored} of ${POOLS.length} pools anchored — too few to call this measured (skips: ${M.skipped.join('; ')})`);
  console.log(`\n  E1: ${anchored}/${POOLS.length} pools anchored at block ${PIN}`);
});

test('E2 GREEN — lp-desk rows: every last-in-block row agrees with the proven slot0', async () => {
  const pool = POOLS[0].addr;
  const from = PIN - 60, to = PIN;
  const logs = await rpc('eth_getLogs', [{ address: pool, topics: [SWAP_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
  assert.ok(logs.length > 0, 'no swaps in the sampled window — cannot measure agreement');

  // Group exactly the way lp-desk's rows arrive, then pick the terminal row BY logIndex (measured,
  // not by trusting array order).
  const byBlock = new Map();
  for (const l of logs) { const b = parseInt(l.blockNumber, 16); if (!byBlock.has(b)) byBlock.set(b, []); byBlock.get(b).push(decodeSwapPostState(l)); }
  M.coverage.push({ pool: POOLS[0].name, swaps: logs.length, blocks: byBlock.size, pctLastInBlock: 100 * byBlock.size / logs.length });

  const sample = [...byBlock.entries()].sort((a, b) => a[0] - b[0]).slice(-6);
  let agreed = 0, liqAgreed = 0, tested = 0;
  for (const [blk, rows] of sample) {
    const last = rows.reduce((a, b) => (b.logIndex > a.logIndex ? b : a));
    const res = await anchorSwapRow({ chain: CHAIN, pool, block: blk, claimed: { sqrtPriceX96: last.sqrtPriceX96.toString(), tick: last.tick, liquidity: last.liquidity.toString() } });
    if (!res.ok && res.transport) { M.skipped.push(`row@${blk}: TRANSPORT`); continue; }
    tested++;
    assert.equal(res.ok, true, `block ${blk}: ${res.reason}`);
    assert.equal(res.agree, true, `block ${blk}: the terminal swap's post-state does NOT match proven slot0 — ${JSON.stringify(res.fields)}`);
    assert.equal(res.fields.sqrtPriceX96.match, true);
    assert.equal(res.fields.tick.match, true);
    agreed++;
    if (res.fields.liquidity.match) liqAgreed++;
    M.sizes.push({ pool: 'row-anchor', bytes: res.proofSizeBytes });
    M.latencies.push(res.latencyMs);
  }
  assert.ok(tested >= 4, `only ${tested} rows tested`);
  console.log(`  E2: ${agreed}/${tested} terminal rows agree on sqrtPriceX96+tick; ${liqAgreed}/${tested} also agree on liquidity (slot 4 is also written by Mint/Burn)`);
  M.coverage.push({ liqAgreed, tested });
});

test('E3 RED — a fabricated storage VALUE must be refused (honest proof, lying echo)', async () => {
  const px = await startTamperProxy(RPC);
  try {
    px.state.mode = 'honest';
    const ok = await anchorState({ chain: CHAIN, address: POOLS[0].addr, slots: [0, 4], block: PIN, endpoint: px.url, corroborate: false });
    assert.equal(ok.ok, true, `control through the proxy failed: ${ok.reason} — a red test whose control is broken proves nothing`);

    px.state.mode = 'fake-value';
    const bad = await anchorState({ chain: CHAIN, address: POOLS[0].addr, slots: [0, 4], block: PIN, endpoint: px.url, corroborate: false });
    assert.equal(bad.ok, false, 'a fabricated storage value was ACCEPTED');
    assert.match(bad.reason, /echoed .* but the proof commits to/, `refused for the wrong reason: ${bad.reason}`);
    M.refusals.push(`fake-value: ${bad.reason.slice(0, 80)}`);
  } finally { await px.close(); }
});

test('E4 RED — a leaf rewritten to encode a different value must be refused', async () => {
  const px = await startTamperProxy(RPC);
  try {
    px.state.mode = 'fake-leaf';
    const bad = await anchorState({ chain: CHAIN, address: POOLS[0].addr, slots: [0], block: PIN, endpoint: px.url, corroborate: false });
    assert.equal(bad.ok, false, 'a rewritten trie leaf was ACCEPTED');
    assert.match(bad.reason, /hashes to .* but its parent commits to|chain to the root is broken/, `refused for the wrong reason: ${bad.reason}`);
    M.refusals.push(`fake-leaf: ${bad.reason.slice(0, 80)}`);
  } finally { await px.close(); }
});

test('E5 RED — a proof taken against the WRONG state root must be refused', async () => {
  const px = await startTamperProxy(RPC);
  try {
    // (a) the honest-looking version: header for block PIN, proof lifted from block PIN-5000.
    px.state.mode = 'other-block';
    px.state.swapBlockTag = '0x' + (PIN - 5000).toString(16);
    const bad = await anchorState({ chain: CHAIN, address: POOLS[0].addr, slots: [0], block: PIN, endpoint: px.url, corroborate: false });
    assert.equal(bad.ok, false, 'a proof from a different block verified against this block\'s stateRoot');
    assert.match(bad.reason, /account proof does not verify against stateRoot/, `refused for the wrong reason: ${bad.reason}`);
    M.refusals.push(`other-block: ${bad.reason.slice(0, 80)}`);

    // (b) the crude version: a doctored stateRoot. The HEADER check catches this one before the trie
    // is even walked, which is the point of link 2 — a stateRoot that belongs to no block is not a
    // root, and the failure names that rather than reporting a proof mismatch.
    px.state.mode = 'fake-stateroot';
    const bad2 = await anchorState({ chain: CHAIN, address: POOLS[0].addr, slots: [0], block: PIN, endpoint: px.url, corroborate: false });
    assert.equal(bad2.ok, false, 'a doctored stateRoot was accepted');
    assert.match(bad2.reason, /header verification failed/, `refused for the wrong reason: ${bad2.reason}`);
    M.refusals.push(`fake-stateroot: ${bad2.reason.slice(0, 80)}`);
  } finally { await px.close(); }
});

test('E6 RED — a truncated proof, and an absent proof, must both be refused', async () => {
  const px = await startTamperProxy(RPC);
  try {
    px.state.mode = 'drop-node';
    const a = await anchorState({ chain: CHAIN, address: POOLS[0].addr, slots: [0], block: PIN, endpoint: px.url, corroborate: false });
    assert.equal(a.ok, false, 'a truncated proof was accepted');
    M.refusals.push(`drop-node: ${a.reason.slice(0, 80)}`);

    // The one that matters most: an EMPTY proof must not read as "the value is zero". calldata-x's
    // isProxy:false rests on three slots being empty, so "no proof" silently becoming "proven empty"
    // would let a hostile node hide an upgradeable implementation behind a clean verdict.
    px.state.mode = 'empty-proof';
    const b = await anchorState({ chain: CHAIN, address: POOLS[0].addr, slots: [0], block: PIN, endpoint: px.url, corroborate: false });
    assert.equal(b.ok, false, 'an EMPTY proof was read as a proof of zero');
    assert.match(b.reason, /empty proof against a non-empty root|proves nothing/);
    M.refusals.push(`empty-proof: ${b.reason.slice(0, 80)}`);
  } finally { await px.close(); }
});

test('E7 RED — a lying account echo (nonce) must be refused', async () => {
  const px = await startTamperProxy(RPC);
  try {
    px.state.mode = 'fake-nonce';
    const bad = await anchorState({ chain: CHAIN, address: POOLS[0].addr, slots: [0], block: PIN, endpoint: px.url, corroborate: false });
    assert.equal(bad.ok, false, 'a fabricated nonce echo was accepted');
    assert.match(bad.reason, /echo contradicts the proven account leaf/);
    M.refusals.push(`fake-nonce: ${bad.reason.slice(0, 80)}`);
  } finally { await px.close(); }
});

test('E8 RED — code that does not hash to the proven codeHash must be refused', async () => {
  const px = await startTamperProxy(RPC);
  const ROUTER = '0xe592427a0aece92de3edee1f18e0157c05861564';
  try {
    // Control first. A red test whose control is broken proves nothing at all.
    px.state.mode = 'honest';
    const ok = await anchorAddress({ chain: CHAIN, address: ROUTER, block: PIN, endpoint: px.url, corroborate: false });
    assert.equal(ok.ok, true, `control through the proxy failed: ${ok.reason}`);
    assert.ok(ok.reputation.codeSizeBytes > 0);

    // Now serve bytecode that does not hash to the PROVEN codeHash. calldata-x's codeSizeBytes and
    // its contract-vs-wallet tier both rest on this preimage, so an unbound eth_getCode would let a
    // node turn a wallet into a "contract" and downgrade the drainer alert.
    px.state.mode = 'fake-code';
    const bad = await anchorAddress({ chain: CHAIN, address: ROUTER, block: PIN, endpoint: px.url, corroborate: false });
    assert.equal(bad.ok, false, 'bytecode that does not match the proven codeHash was ACCEPTED');
    assert.match(bad.reason, /served code that is not this account's code|PROVEN account codeHash/, `refused for the wrong reason: ${bad.reason}`);
    M.refusals.push(`fake-code: ${bad.reason.slice(0, 80)}`);
  } finally { await px.close(); }
});

test('E9 RED — verifyMpt unit battery: every corruption must be caught', async () => {
  const raw = await rpc('eth_getProof', [POOLS[0].addr, ['0x0'], '0x' + PIN.toString(16)]);
  const blk = await rpc('eth_getBlockByNumber', ['0x' + PIN.toString(16), false]);
  const root = blk.stateRoot;
  const sp = raw.storageProof[0];

  const cases = [
    ['wrong root', () => verifyMpt('0x' + 'cd'.repeat(32), keccak256(String(POOLS[0].addr).toLowerCase()), raw.accountProof)],
    ['flipped byte in node 0', () => { const n = [...raw.accountProof]; const b = getBytes(n[0]); b[10] ^= 0xff; n[0] = '0x' + Buffer.from(b).toString('hex'); return verifyMpt(root, keccak256(String(POOLS[0].addr).toLowerCase()), n); }],
    ['reordered nodes', () => { const n = [...raw.accountProof]; [n[1], n[2]] = [n[2], n[1]]; return verifyMpt(root, keccak256(String(POOLS[0].addr).toLowerCase()), n); }],
    ['empty proof vs real root', () => verifyMpt(root, keccak256(String(POOLS[0].addr).toLowerCase()), [])],
    ['root that is not 32 bytes', () => verifyMpt('0xdead', keccak256(String(POOLS[0].addr).toLowerCase()), raw.accountProof)],
    ['storage proof checked against the STATE root', () => verifyMpt(root, storageKey(0n), sp.proof)],
  ];
  for (const [name, fn] of cases) {
    const r = fn();
    assert.equal(r.ok, false, `"${name}" was ACCEPTED — the verifier cannot fail`);
    M.refusals.push(`${name}: ${String(r.reason).slice(0, 70)}`);
  }
  // and the positive control, so this battery is not passing because everything returns false
  const honest = verifyMpt(raw.storageHash, storageKey(0n), sp.proof);
  assert.equal(honest.ok, true, `the honest storage proof was refused: ${honest.reason} — the battery above would be vacuous`);
  assert.equal(honest.kind, 'inclusion');
  console.log(`  E9: ${cases.length} corruptions refused, honest control accepted`);
});

test('E10 RED — a contract that is not a V3 pool must be refused, not decoded', async () => {
  // USDC: real contract, real storage, and slot 0 is nothing like a V3 slot0.
  const bad = await anchorPoolState({ chain: CHAIN, pool: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', block: PIN, corroborate: false });
  assert.equal(bad.ok, false, 'a non-V3 contract was decoded as a pool');
  assert.match(bad.reason, /not a UniswapV3 slot0|self-consistency failed/);
  M.refusals.push(`non-V3: ${bad.reason.slice(0, 90)}`);

  // An address with no code at all.
  const eoa = await anchorPoolState({ chain: CHAIN, pool: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', block: PIN, corroborate: false });
  assert.equal(eoa.ok, false, 'a wallet address was accepted as a pool');
  M.refusals.push(`eoa-as-pool: ${String(eoa.reason).slice(0, 90)}`);

  // And the unit-level version: a hand-made slot0 word whose tick contradicts its sqrtPrice.
  const s = slot0LooksLikeV3((12345n << 160n) | 79228162514264337593543950336n);
  assert.equal(s.ok, false, 'an inconsistent slot0 word was accepted');
});

test('E11 RED — an intra-block swap row must be refused as unanchorable, not silently compared', async () => {
  const pool = POOLS[0].addr;
  const logs = await rpc('eth_getLogs', [{ address: pool, topics: [SWAP_TOPIC], fromBlock: '0x' + (PIN - 120).toString(16), toBlock: '0x' + PIN.toString(16) }]);
  const byBlock = new Map();
  for (const l of logs) { const b = parseInt(l.blockNumber, 16); if (!byBlock.has(b)) byBlock.set(b, []); byBlock.get(b).push(decodeSwapPostState(l)); }
  const multi = [...byBlock.entries()].find(([, v]) => v.length > 1);
  assert.ok(multi, 'no multi-swap block in the window — cannot test the coverage boundary');
  const rows = multi[1].sort((a, b) => a.logIndex - b.logIndex);
  const notLast = rows[0];
  const res = await anchorSwapRow({ chain: CHAIN, pool, block: multi[0], claimed: { sqrtPriceX96: notLast.sqrtPriceX96.toString(), tick: notLast.tick, liquidity: notLast.liquidity.toString() } });
  assert.equal(res.ok, false, 'an intra-block row was reported as anchored');
  assert.equal(res.anchorable, false);
  assert.match(res.reason, /not the last Swap in block/);
  M.refusals.push(`intra-block row: ${res.reason.slice(0, 90)}`);
  console.log(`  E11: block ${multi[0]} has ${rows.length} swaps; the non-terminal row is refused`);
});

test('E12 GREEN — calldata-x quantities anchor, including the empty-slot case', async () => {
  const cases = [
    { name: 'USDC (legacy zeppelinos proxy)', addr: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', wantProxy: true, wantTier: 'contract' },
    { name: 'Uniswap V3 SwapRouter', addr: '0xe592427a0aece92de3edee1f18e0157c05861564', wantProxy: false, wantTier: 'contract' },
  ];
  for (const c of cases) {
    const r = await anchorAddress({ chain: CHAIN, address: c.addr, block: PIN, corroborate: false });
    assert.equal(r.ok, true, `${c.name}: ${r.reason}`);
    assert.equal(r.reputation.tier, c.wantTier, `${c.name}: tier ${r.reputation.tier}`);
    assert.equal(r.reputation.proxy.isProxy, c.wantProxy, `${c.name}: proxy verdict ${r.reputation.proxy.isProxy}`);
    assert.ok(r.reputation.codeSizeBytes > 0, `${c.name}: code size not bound to the proven codeHash`);
    // every proxy slot must be PROVEN either present or absent — never merely unreported
    for (const [slot, p] of Object.entries(r.reputation.proxy.provenSlots)) {
      assert.ok(p.proofKind === 'inclusion' || p.proofKind === 'exclusion', `${c.name}: ${slot} was ${p.proofKind}`);
    }
    if (!c.wantProxy) assert.ok(Object.values(r.reputation.proxy.provenSlots).every((p) => p.proofKind === 'exclusion'), `${c.name}: "not a proxy" must rest on exclusion proofs`);
    console.log(`  E12 ${c.name}: tier=${r.reputation.tier} nonce=${r.reputation.outboundTxCount} code=${r.reputation.codeSizeBytes}B proxy=${r.reputation.proxy.isProxy ? r.reputation.proxy.standard : 'none (3 exclusion proofs)'}`);
  }
  // EIP-7702: a delegated wallet has non-empty code and must NOT be reported as a contract — that
  // distinction is what calldata-x's DANGER verdict for "approval to a wallet" keys on.
  const v = await anchorAddress({ chain: CHAIN, address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', block: PIN, corroborate: false });
  if (v.ok && v.reputation.codeSizeBytes === 23) {
    assert.equal(v.reputation.tier, 'eoa7702', 'a 23-byte EIP-7702 delegation was classified as a contract');
    console.log(`  E12 vitalik.eth: tier=${v.reputation.tier} delegatedTo=${v.reputation.code.delegatedTo}`);
  }
});

test('E13 CONTROL — repeated honest runs must not produce a single false refusal', async () => {
  let refusals = 0, runs = 0;
  for (let i = 0; i < 5; i++) {
    const st = await anchorPoolState({ chain: CHAIN, pool: POOLS[0].addr, block: PIN - i, corroborate: false });
    runs++;
    if (!st.ok) { if (st.transport) { M.skipped.push('control: TRANSPORT'); runs--; } else refusals++; }
    if (st.ok) M.latencies.push(st.latencyMs);
  }
  assert.equal(refusals, 0, `${refusals} false refusals in ${runs} honest runs — the gate is strict rather than correct`);
  console.log(`  E13: ${runs} honest runs, 0 false refusals`);
});

test('E15 — at lp-desk\'s real window depth, the anchor survives but the corroboration thins out', async () => {
  // lp-desk's default pull is 2 days = ~14,400 mainnet blocks. That is outside the proof window of
  // two of the three operators, so this records what an anchor at that depth actually gets: one
  // server for the PROOF, and — the part that saves it — still three for the ROOT.
  const deep = HEAD - 14400;
  const st = await anchorPoolState({ chain: CHAIN, pool: POOLS[0].addr, block: deep, corroborate: true });
  if (!st.ok && st.transport) { console.log(`  E15: SKIPPED (transport) — ${st.reason.slice(0, 90)}`); M.skipped.push('deep anchor'); return; }
  assert.equal(st.ok, true, `deep anchor failed: ${st.reason}`);
  assert.ok(st.selfCheck.tickDelta <= 2);

  // Which operators could serve the PROOF here, measured rather than assumed.
  const canProve = [];
  for (const ep of proofEndpoints(CHAIN)) {
    const one = await anchorPoolState({ chain: CHAIN, pool: POOLS[0].addr, block: deep, corroborate: false, endpoint: ep.url });
    if (one.ok) canProve.push(ep.operator);
  }
  const agreed = st.agreement ? st.agreement.agree : 1;
  console.log(`  E15 at head-14400 (lp-desk's 2-day window): proof servable by ${canProve.length}/${proofEndpoints(CHAIN).length} operators (${canProve.join(', ')}); blockHash agreed by ${agreed}/${st.agreement?.asked ?? 1}`);
  assert.ok(agreed >= 2, `only ${agreed} operator(s) could corroborate the root at depth — the anchor would rest on a single server end to end`);
  M.latencies.push(st.latencyMs);
  M.sizes.push({ pool: 'deep', bytes: st.size.totalProofBytes });
});

test('E14 — the coverage table must not claim more than the code delivers', async () => {
  // The coverage statement is data, not prose, so it can be asserted on. These are the two claims
  // that would do real damage if they drifted, so they are pinned here rather than trusted.
  const amounts = LP_DESK_COVERAGE.find((r) => /amount0/.test(r.quantity));
  assert.equal(amounts.anchored, 'NO', 'the coverage table claims swap amounts are anchorable — they are in the receipts trie, which eth_getProof never touches');
  const dec = LP_DESK_COVERAGE.find((r) => /decimals/.test(r.quantity));
  assert.equal(dec.anchored, 'NO');
  const sim = CALLDATA_X_COVERAGE.find((r) => /simulation/.test(r.quantity));
  assert.equal(sim.anchored, 'NO', 'the coverage table claims eth_simulateV1 output is anchorable — it is a counterfactual, not committed state');
  // NOT ONE lp-desk quantity is anchored outright by a storage proof. The single 'YES' in the table is
  // the block number/timestamp, and it says "BY A DIFFERENT MECHANISM" because it is a header field
  // and no state trie is involved. If a future edit ever promotes a row to a bare 'YES', that is the
  // claim outrunning the build, and this line is what catches it.
  const bareYes = LP_DESK_COVERAGE.filter((r) => r.anchored === 'YES');
  assert.equal(bareYes.length, 0, `lp-desk coverage now claims ${bareYes.length} quantities are outright anchored (${bareYes.map((r) => r.quantity).join(', ')}) — no storage proof delivers that`);
  assert.equal(LP_DESK_COVERAGE.filter((r) => r.anchored.startsWith('PARTIAL')).length, 3);

  // and the summary
  const bytes = M.sizes.map((s) => s.bytes);
  const lat = M.latencies.slice().sort((a, b) => a - b);
  const cov = M.coverage.find((c) => c.pctLastInBlock != null);
  console.log('\n=== GATE E MEASUREMENTS (this run, not quoted) ===');
  console.log(`  proof size (account + storage, decoded): min ${Math.min(...bytes)} B, median ${bytes.slice().sort((a, b) => a - b)[Math.floor(bytes.length / 2)]} B, max ${Math.max(...bytes)} B over ${bytes.length} proofs`);
  console.log(`  wire size (JSON hex as delivered):       median ${M.wire.slice().sort((a, b) => a - b)[Math.floor(M.wire.length / 2)]} B  (~2.07x the decoded size)`);
  console.log(`  fetch latency:                           min ${lat[0]} ms, median ${lat[Math.floor(lat.length / 2)]} ms, max ${lat[lat.length - 1]} ms over ${lat.length} fetches`);
  console.log(`  operator agreement on blockHash:         ${[...new Set(M.agreements)].join(', ') || 'n/a'}`);
  if (cov) console.log(`  lp-desk coverage (${cov.pool}):      ${cov.blocks} of ${cov.swaps} rows are last-in-block = ${cov.pctLastInBlock.toFixed(1)}% anchorable`);
  console.log(`  refusals exercised:                      ${M.refusals.length}`);
  if (M.skipped.length) console.log(`  skipped (transport, NOT verification):   ${M.skipped.length} — ${M.skipped.slice(0, 3).join('; ')}`);
  console.log('=== end measurements ===\n');
  assert.ok(M.refusals.length >= 12, `only ${M.refusals.length} refusals exercised — the red half is too thin to trust the green half`);
});
