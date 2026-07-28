// eth_getProof state anchoring. Merkle-Patricia verification against a block's stateRoot.
//
// WHAT THIS PROVES, EXACTLY. A verified proof says: "a state trie whose root is R contains value V at
// key K". Nothing more. Three separate links have to hold before that is worth anything, and each one
// is a different kind of claim:
//
//   1. TRIE , keccak-chained nodes from R down to the leaf. Pure cryptography, no trust. (verifyMpt)
//   2. HEADER. R is the stateRoot inside a header whose keccak256(rlp(header)) equals the reported
//      blockHash. Also pure cryptography, and it is the link that stops an RPC handing back a stateRoot
//      that belongs to no block at all. (headerHash)
//   3. CANONICITY, that blockHash is the one the network actually agreed on at that height. This is
//      NOT cryptography and this module CANNOT close it. All it can do is ask several independent
//      operators and report whether they agree. (corroborateHeader)
//
// Link 3 is the honest ceiling. A malicious RPC that answered every call from a fabricated chain would
// pass links 1 and 2 perfectly: it controls the header it hands you, so it can mint a matching stateRoot
// and a matching proof. Only a consensus-layer light client (or an on-chain verifier reading BLOCKHASH /
// the EIP-2935 history contract, where the hash comes from consensus rather than from a wire) closes it.
// Measured operator agreement is a real but bounded substitute, and it is labelled as such everywhere.
//
// THE PROOF WINDOW IS THE REAL CONSTRAINT, and it is not the one the research predicted. Measured
// 2026-07-28 by walking each endpoint back until it refused:
//
//   endpoint                              serves eth_getProof at        serves eth_getBlockByNumber at
//   ------------------------------------  ---------------------------   ------------------------------
//   rpc.mevblocker.io                     head-1,000,000 (full archive) head-100,000 +
//   eth.api.onfinality.io/public          head-256, refuses head-1024   head-100,000 +
//   ethereum-rpc.publicnode.com           head-64,  refuses head-128    head-100,000 +
//   arb1.arbitrum.io/rpc                  head-256, refuses head-1024   (n/a)
//   mainnet.base.org                      shallow only, rate-limits hard after a few calls
//   base-rpc.publicnode.com               REFUSES ("maximum proof window") at every depth tried
//
// Two consequences the endpoint list is built around:
//
//   1. Serving eth_call or eth_getLogs does NOT imply serving eth_getProof, so this list is its own
//      list and is not inherited from evmrpc.js / univ3.js. It is ORDERED BY MEASURED DEPTH, not by
//      latency, because a fast node that refuses the height is worth nothing to an anchor.
//   2. HEADERS survive at depth on every operator even where PROOFS do not, all three mainnet
//      operators returned the identical blockHash at head-100,000. So the proof needs one archive
//      node while the ROOT it is checked against stays corroborable by three. That asymmetry is the
//      only reason multi-operator corroboration is available for a historical window at all.
//
//   • Header RLP reconstructs the blockHash with 21 fields on ethereum and base (through requestsHash)
//     and 16 on arbitrum (through baseFeePerGas). The tail is OPTIONAL and version-dependent, so the
//     encoder stops at the first absent field and REFUSES if the hash does not come out, it never
//     guesses which fork it is talking to.
import { keccak256, encodeRlp, decodeRlp, getBytes, hexlify } from 'ethers';

// Ordered by MEASURED proof depth (deepest first). `proofDepth` is the deepest height that answered,
// recorded so a caller can see why an anchor at 14,400 blocks back has one server and not three.
const PROOF_RPCS = {
  ethereum: [
    { url: 'https://rpc.mevblocker.io', operator: 'CoW/Beaverbuild (MEV Blocker)', proofDepth: 1000000 },
    { url: 'https://eth.api.onfinality.io/public', operator: 'OnFinality', proofDepth: 256 },
    { url: 'https://ethereum-rpc.publicnode.com', operator: 'Allnodes (publicnode)', proofDepth: 64 },
  ],
  arbitrum: [
    { url: 'https://arb1.arbitrum.io/rpc', operator: 'Offchain Labs', proofDepth: 256 },
  ],
  base: [
    // Kept because it does answer, and excluded from nothing, but it rate-limits within a handful of
    // calls and has returned "no state found" four blocks behind its own head. A gate that runs a
    // batch of Base proofs will go red on rate limits, which is NOT a cryptographic failure and must
    // never be reported as one.
    { url: 'https://mainnet.base.org', operator: 'Coinbase (Base sequencer RPC)', proofDepth: 32, flaky: 'rate-limits within a few calls' },
  ],
};

export const EMPTY_CODE_HASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
export const EMPTY_TRIE_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';

// ---------------------------------------------------------------------------------------------
// JSON-RPC

// A TRANSPORT failure and a VERIFICATION failure are different events and must never be reported as
// the same thing. Measured the hard way: a free node under load stops answering JSON and starts
// serving an HTML rate-limit page, which JSON.parse rejects, and a gate that read that as "the proof
// did not verify" would report a cryptographic failure that never happened. Everything below marks
// transport errors so callers can retry or skip them, and nothing marks a bad proof that way.
function markTransport(e) { e.transport = true; return e; }

async function call(url, method, params, timeoutMs = 20000) {
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) { throw markTransport(new Error(`${method}: ${String(e.message).slice(0, 80)}`)); }
  const text = await r.text().catch(() => '');
  let j;
  try { j = JSON.parse(text); }
  catch { throw markTransport(new Error(`${method}: HTTP ${r.status}, non-JSON reply (${text.slice(0, 60).replace(/\s+/g, ' ')}), rate limit or gateway page, not an RPC answer`)); }
  if (j.error) {
    const msg = String(j.error.message || JSON.stringify(j.error));
    const e = new Error(`${method}: ${msg.slice(0, 160)}`);
    e.rpcError = j.error;
    // "this node will not serve that height" is a capability limit, not a verification failure.
    if (/rate limit|too many|archive|proof window|missing trie node|historical state|no state found|personal token|not available/i.test(msg)) markTransport(e);
    throw e;
  }
  return { result: j.result, ms: Date.now() - t0, wireBytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * Retry a call on the SAME url while the failure is transport. Deliberately not a fallback to another
 * endpoint: a caller that pinned an endpoint (the tamper proxy in gate E, or a node chosen because it
 * is the only one holding the height) must not be silently rerouted to a different server, or the
 * answer stops being about the server that was asked. Only transport is retried; an RPC that answers
 * with a verifiable-but-wrong result is returned on the first try, every time.
 */
async function callRetry(url, method, params, { tries = 4, timeoutMs = 20000 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return await call(url, method, params, timeoutMs); }
    catch (e) { if (!e.transport) throw e; last = e; await new Promise((r) => setTimeout(r, 200 * (i + 1) ** 2)); }
  }
  throw last;
}

export const proofEndpoints = (chain) => (PROOF_RPCS[String(chain).toLowerCase()] || []).map((e) => ({ ...e }));

// Round-robin start index per chain. Free endpoints rate-limit, and hammering the first one in the
// list is what turns a working gate into an HTML error page halfway through a run.
const rr = new Map();
function rotate(chain, eps) {
  if (eps.length < 2) return eps;
  const i = (rr.get(chain) || 0) % eps.length;
  rr.set(chain, i + 1);
  return [...eps.slice(i), ...eps.slice(0, i)];
}

// ---------------------------------------------------------------------------------------------
// Block header -> blockHash. Link 2 of the trust chain.

// Canonical RLP field order. The tail (withdrawalsRoot onward) arrived with Shanghai/Cancun/Prague and
// is absent on older blocks and on chains that never adopted it, so it is treated as an optional tail.
export const HEADER_FIELDS = [
  'parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot',
  'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData',
  'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas',
  'parentBeaconBlockRoot', 'requestsHash',
];
// RLP encodes QUANTITIES minimally (no leading zero bytes) and DATA verbatim. Getting this backwards
// produces a hash that is wrong by a byte and looks like an unsupported fork.
const QUANTITY = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']);

function normField(name, v) {
  let h = String(v).toLowerCase();
  if (!h.startsWith('0x')) h = '0x' + h;
  if (QUANTITY.has(name)) {
    let s = h.slice(2).replace(/^0+/, '');
    if (s.length % 2) s = '0' + s;
    return '0x' + s;            // 0 -> '0x' (the empty string), which is what RLP wants
  }
  if (h.length % 2) h = '0x0' + h.slice(2);
  return h;
}

/**
 * Recompute a block hash from its header fields. Returns { ok, hash, fields, reason }.
 * REFUSES (ok:false) rather than reporting a near-miss: if the recomputed hash does not equal the
 * reported one we do not know which preimage the node used, so the stateRoot is not pinned to anything.
 */
export function headerHash(blk) {
  if (!blk || typeof blk !== 'object') return { ok: false, reason: 'no block object' };
  const items = [], used = [];
  for (const f of HEADER_FIELDS) {
    if (blk[f] === undefined || blk[f] === null) break;   // optional tail ends here
    items.push(normField(f, blk[f]));
    used.push(f);
  }
  if (used.length < 15) return { ok: false, reason: `header is missing mandatory fields (only ${used.length} present)` };
  let hash;
  try { hash = keccak256(encodeRlp(items)); } catch (e) { return { ok: false, reason: `header RLP failed: ${String(e.message).slice(0, 80)}` }; }
  const reported = String(blk.hash || '').toLowerCase();
  if (hash.toLowerCase() !== reported) {
    return { ok: false, hash, reported, fields: used, reason: `recomputed header hash ${hash} != reported ${reported}, the ${used.length}-field encoding does not match this chain/fork, so stateRoot is NOT pinned to a block. Refusing rather than trusting the stateRoot on the node's word.` };
  }
  return { ok: true, hash, fields: used, fieldCount: used.length };
}

// ---------------------------------------------------------------------------------------------
// Merkle-Patricia trie verification. Link 1 of the trust chain.

const nibblesOf = (bytes) => { const out = new Uint8Array(bytes.length * 2); for (let i = 0; i < bytes.length; i++) { out[2 * i] = bytes[i] >> 4; out[2 * i + 1] = bytes[i] & 0x0f; } return out; };

// Hex-prefix decoding (Ethereum yellow paper appendix C): the first nibble carries a leaf flag and an
// odd-length flag. Reading it as raw path nibbles silently shifts every subsequent comparison by one.
function decodePath(hex) {
  const b = getBytes(hex);
  if (b.length === 0) return { leaf: false, path: new Uint8Array(0) };
  const n = nibblesOf(b);
  const flag = n[0];
  const leaf = flag >= 2;
  const odd = flag % 2 === 1;
  return { leaf, path: n.slice(odd ? 1 : 2) };
}

const isList = (x) => Array.isArray(x);

/**
 * Verify a Merkle-Patricia proof.
 * @param rootHex  32-byte root the proof must chain up to
 * @param keyHex   the TRIE key (already keccak-hashed: keccak(address) or keccak(pad32(slot)))
 * @param nodesHex array of RLP-encoded nodes, root first (as eth_getProof returns them)
 * @returns { ok, kind:'inclusion'|'exclusion', value (hex RLP payload | null), reason, nodesUsed }
 *
 * Both outcomes are PROOFS. An exclusion proof is what makes "this storage slot is zero" a verified
 * statement instead of an absence of evidence, which matters directly: calldata-x's `isProxy:false`
 * rests on three EIP-1967 slots being empty, and a verifier that could not prove emptiness would have
 * to report "unknown" for every non-proxy contract on chain.
 */
export function verifyMpt(rootHex, keyHex, nodesHex) {
  let root;
  try { root = hexlify(rootHex).toLowerCase(); } catch { return { ok: false, reason: 'root is not hex' }; }
  if (!/^0x[0-9a-f]{64}$/.test(root)) return { ok: false, reason: `root must be a 32-byte hash, got ${root.slice(0, 20)}` };
  if (!Array.isArray(nodesHex)) return { ok: false, reason: 'proof is not an array of nodes' };

  const key = nibblesOf(getBytes(keyHex));
  // An empty proof against the empty-trie root is a valid exclusion proof; against anything else it is
  // not a proof of anything, and must not be read as "the value is zero".
  if (nodesHex.length === 0) {
    return root === EMPTY_TRIE_ROOT
      ? { ok: true, kind: 'exclusion', value: null, nodesUsed: 0, reason: 'empty trie' }
      : { ok: false, reason: 'empty proof against a non-empty root, proves nothing (an absent proof is not an exclusion proof)' };
  }

  let expect = root;          // a 32-byte hash we must match next...
  let embedded = null;        // ...or an already-decoded node inlined in its parent (RLP < 32 bytes)
  let i = 0;                  // nibble cursor
  let used = 0;

  for (let step = 0; step < 128; step++) {
    let node;
    if (embedded) { node = embedded; embedded = null; }
    else {
      if (used >= nodesHex.length) return { ok: false, reason: `proof ran out of nodes at depth ${step} while still expecting ${expect.slice(0, 12)}…` };
      const rawHex = nodesHex[used++];
      let raw;
      try { raw = getBytes(rawHex); } catch { return { ok: false, reason: `node ${used - 1} is not hex` }; }
      const h = keccak256(raw).toLowerCase();
      if (h !== expect) return { ok: false, reason: `node ${used - 1} hashes to ${h.slice(0, 14)}… but its parent commits to ${expect.slice(0, 14)}…, the chain to the root is broken` };
      try { node = decodeRlp(raw); } catch (e) { return { ok: false, reason: `node ${used - 1} is not valid RLP: ${String(e.message).slice(0, 60)}` }; }
    }
    if (!isList(node)) return { ok: false, reason: `node ${used - 1} decoded to a string, not a trie node` };

    if (node.length === 17) {                                  // BRANCH
      if (i >= key.length) {
        const v = node[16];
        return (v && v !== '0x')
          ? { ok: true, kind: 'inclusion', value: v, nodesUsed: used }
          : { ok: true, kind: 'exclusion', value: null, nodesUsed: used };
      }
      const child = node[key[i++]];
      if (child === '0x' || child == null || (typeof child === 'string' && child.length <= 2)) {
        return { ok: true, kind: 'exclusion', value: null, nodesUsed: used };
      }
      if (isList(child)) { embedded = child; continue; }
      const c = String(child).toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(c)) return { ok: false, reason: `branch child at depth ${step} is ${c.length / 2 - 1} bytes, neither a 32-byte hash nor an inlined node` };
      expect = c;
      continue;
    }

    if (node.length === 2) {                                   // LEAF or EXTENSION
      const { leaf, path } = decodePath(node[0]);
      const rest = key.slice(i);
      if (leaf) {
        if (rest.length !== path.length) return { ok: true, kind: 'exclusion', value: null, nodesUsed: used };
        for (let k = 0; k < path.length; k++) if (rest[k] !== path[k]) return { ok: true, kind: 'exclusion', value: null, nodesUsed: used };
        return { ok: true, kind: 'inclusion', value: node[1], nodesUsed: used };
      }
      if (rest.length < path.length) return { ok: true, kind: 'exclusion', value: null, nodesUsed: used };
      for (let k = 0; k < path.length; k++) if (rest[k] !== path[k]) return { ok: true, kind: 'exclusion', value: null, nodesUsed: used };
      i += path.length;
      const child = node[1];
      if (isList(child)) { embedded = child; continue; }
      const c = String(child).toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(c)) return { ok: false, reason: `extension child at depth ${step} is not a 32-byte hash` };
      expect = c;
      continue;
    }
    return { ok: false, reason: `node ${used - 1} has ${node.length} items, not a 2-item or 17-item trie node` };
  }
  return { ok: false, reason: 'proof exceeded 128 levels, malformed' };
}

// A storage leaf holds RLP(minimal-big-endian value), so the leaf payload must be RLP-decoded once more.
function decodeStorageLeaf(payload) {
  try {
    const v = decodeRlp(payload);
    if (isList(v)) return null;
    return BigInt(v === '0x' ? '0x0' : v);
  } catch { return null; }
}

// An account leaf holds RLP([nonce, balance, storageHash, codeHash]).
function decodeAccountLeaf(payload) {
  try {
    const a = decodeRlp(payload);
    if (!isList(a) || a.length !== 4) return null;
    const q = (x) => BigInt(x === '0x' ? '0x0' : x);
    return { nonce: q(a[0]), balance: q(a[1]), storageHash: String(a[2]).toLowerCase(), codeHash: String(a[3]).toLowerCase() };
  } catch { return null; }
}

export const storageKey = (slot) => keccak256('0x' + BigInt(slot).toString(16).padStart(64, '0'));
export const accountKey = (address) => keccak256(String(address).toLowerCase());

// ---------------------------------------------------------------------------------------------
// The full anchor: fetch, verify all three links, report what each one actually established.

/**
 * Fetch and verify an eth_getProof for `address` at `slots` and `blockTag`.
 *
 * Returns { ok:false, reason } on ANY failure, a missing header field, a broken node chain, an RPC
 * that will not serve the height. It never degrades to "probably fine": an unverified proof is the
 * same as no proof, and the caller is not given a value it might mistake for an anchored one.
 */
export async function anchorState({ chain = 'ethereum', address, slots = [], block, endpoint = null, corroborate = true } = {}) {
  const eps = endpoint ? [{ url: endpoint, operator: 'caller-supplied' }] : rotate(chain, proofEndpoints(chain));
  if (!eps.length) return { ok: false, reason: `no eth_getProof endpoint is known for chain '${chain}', refusing rather than guessing one (measured list: ${Object.keys(PROOF_RPCS).join(', ')})` };
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) return { ok: false, reason: `address '${address}' is not a 20-byte hex address` };
  const tag = typeof block === 'number' ? '0x' + block.toString(16) : String(block || 'latest');
  if (tag === 'latest') return { ok: false, reason: "refusing 'latest': an anchor must name a fixed height, or it proves nothing reproducible" };

  const slotHex = slots.map((s) => '0x' + BigInt(s).toString(16));
  let lastErr = null, lastTransport = false;

  for (const ep of eps) {
    let blk, pf;
    try {
      const b = await call(ep.url, 'eth_getBlockByNumber', [tag, false]);
      blk = b.result;
      if (!blk) throw markTransport(new Error('eth_getBlockByNumber returned null (height not available on this node)'));
      const p = await call(ep.url, 'eth_getProof', [address, slotHex, tag]);
      pf = { ...p };
      if (!pf.result) throw markTransport(new Error('eth_getProof returned null'));
    } catch (e) { lastErr = `${ep.url}: ${String(e.message).slice(0, 150)}`; lastTransport = !!e.transport; continue; }

    // LINK 2, header preimage. Do this BEFORE trusting stateRoot for anything.
    const hh = headerHash(blk);
    if (!hh.ok) return { ok: false, reason: `header verification failed on ${ep.url}: ${hh.reason}`, endpoint: ep.url };

    const stateRoot = String(blk.stateRoot).toLowerCase();
    const res = pf.result;

    // LINK 1a, account proof against stateRoot.
    const av = verifyMpt(stateRoot, accountKey(address), res.accountProof || []);
    if (!av.ok) return { ok: false, reason: `account proof does not verify against stateRoot ${stateRoot.slice(0, 14)}…: ${av.reason}`, endpoint: ep.url };

    let account, storageHash;
    if (av.kind === 'exclusion') {
      account = { nonce: 0n, balance: 0n, storageHash: EMPTY_TRIE_ROOT, codeHash: EMPTY_CODE_HASH, absent: true };
      storageHash = EMPTY_TRIE_ROOT;
    } else {
      account = decodeAccountLeaf(av.value);
      if (!account) return { ok: false, reason: 'account leaf did not decode as RLP([nonce,balance,storageHash,codeHash])', endpoint: ep.url };
      storageHash = account.storageHash;
      // The node also echoes these fields; if its echo disagrees with the PROVEN leaf, the echo is the
      // thing that is wrong, and a caller reading res.nonce would have read a lie that verified.
      const echoMismatch = [];
      if (res.nonce != null && BigInt(res.nonce) !== account.nonce) echoMismatch.push(`nonce echo ${BigInt(res.nonce)} != proven ${account.nonce}`);
      if (res.codeHash && String(res.codeHash).toLowerCase() !== account.codeHash) echoMismatch.push('codeHash echo != proven');
      if (res.storageHash && String(res.storageHash).toLowerCase() !== account.storageHash) echoMismatch.push('storageHash echo != proven');
      if (echoMismatch.length) return { ok: false, reason: `RPC's unproven echo contradicts the proven account leaf (${echoMismatch.join('; ')}), refusing`, endpoint: ep.url };
    }

    // LINK 1b, each storage proof against the PROVEN storageHash (never against the echoed one).
    const values = {};
    for (const sp of res.storageProof || []) {
      const slot = BigInt(sp.key);
      const sv = verifyMpt(storageHash, storageKey(slot), sp.proof || []);
      if (!sv.ok) return { ok: false, reason: `storage proof for slot ${sp.key} does not verify against the proven storageHash: ${sv.reason}`, endpoint: ep.url };
      const proven = sv.kind === 'exclusion' ? 0n : decodeStorageLeaf(sv.value);
      if (proven == null) return { ok: false, reason: `storage leaf for slot ${sp.key} did not RLP-decode to a value`, endpoint: ep.url };
      const echoed = BigInt(sp.value ?? '0x0');
      if (echoed !== proven) return { ok: false, reason: `RPC echoed ${sp.value} for slot ${sp.key} but the proof commits to 0x${proven.toString(16)}, refusing the echo`, endpoint: ep.url };
      values['0x' + slot.toString(16)] = { value: proven, hex: '0x' + proven.toString(16).padStart(64, '0'), kind: sv.kind, nodes: (sp.proof || []).length };
    }
    const missing = slotHex.filter((s) => !(s in values));
    if (missing.length) return { ok: false, reason: `RPC returned no storage proof for ${missing.join(', ')}, refusing a partial answer`, endpoint: ep.url };

    // LINK 3, canonicity. Not cryptography. Ask other operators and report, do not conclude.
    let agreement = null;
    if (corroborate && eps.length > 1) agreement = await corroborateHeader(chain, tag, ep.url, blk.hash);

    const accountProofBytes = (res.accountProof || []).reduce((s, n) => s + (n.length - 2) / 2, 0);
    const storageProofBytes = (res.storageProof || []).reduce((s, p) => s + (p.proof || []).reduce((a, n) => a + (n.length - 2) / 2, 0), 0);

    return {
      ok: true,
      chain, address: String(address).toLowerCase(),
      block: { number: parseInt(blk.number, 16), hash: String(blk.hash).toLowerCase(), stateRoot, timestamp: parseInt(blk.timestamp, 16) },
      endpoint: ep.url, operator: ep.operator,
      account: { nonce: account.nonce, balance: account.balance, storageHash: account.storageHash, codeHash: account.codeHash, isEoa: account.codeHash === EMPTY_CODE_HASH, absent: !!account.absent },
      slots: values,
      size: {
        accountProofNodes: (res.accountProof || []).length,
        accountProofBytes,
        storageProofBytes,
        storageProofNodes: (res.storageProof || []).map((p) => (p.proof || []).length),
        totalProofBytes: accountProofBytes + storageProofBytes,
        wireBytes: pf.wireBytes,
      },
      latencyMs: pf.ms,
      headerFieldCount: hh.fieldCount,
      agreement,
      trustChain: {
        trie: `VERIFIED: ${(res.accountProof || []).length} account nodes and ${(res.storageProof || []).length} storage proof(s) keccak-chain to stateRoot ${stateRoot}. Pure cryptography.`,
        header: `VERIFIED: keccak256(rlp(header[${hh.fieldCount} fields])) == ${String(blk.hash).toLowerCase()}, and stateRoot is field 4 of that preimage. Pure cryptography.`,
        canonicity: agreement
          ? `NOT PROVEN, ONLY CORROBORATED: ${agreement.agree}/${agreement.asked} independent operators (${agreement.operators.join(', ')}) report the same blockHash at this height. An adversary controlling all of them still passes every check above, because it supplies the header it is checked against.`
          : 'NOT PROVEN AND NOT CORROBORATED: a single endpoint supplied both the header and the proof, so links 1 and 2 are self-consistent by construction. This is the weakest configuration and it is stated, not hidden.',
        gap: 'Nothing here proves this block is canonical or has the network\'s weight behind it. Closing that needs a consensus-layer light client, or an on-chain verifier reading BLOCKHASH / EIP-2935, where the hash comes from consensus rather than from an HTTPS response.',
      },
    };
  }
  return { ok: false, transport: lastTransport, reason: `no eth_getProof endpoint served ${chain} at ${tag}: ${lastErr || 'unknown'}${lastTransport ? ' [TRANSPORT, a node would not serve the request; NOT a verification failure]' : ''}` };
}

/**
 * Ask every OTHER known operator for the same height and report whether the blockHash agrees.
 * Reports, never concludes: this is the only link that is not cryptography and it stays labelled.
 */
export async function corroborateHeader(chain, tag, primaryUrl, primaryHash) {
  const eps = proofEndpoints(chain).filter((e) => e.url !== primaryUrl);
  const rows = [];
  await Promise.all(eps.map(async (e) => {
    try {
      const { result: b } = await call(e.url, 'eth_getBlockByNumber', [tag, false], 12000);
      if (!b?.hash) { rows.push({ operator: e.operator, url: e.url, hash: null, note: 'height unavailable' }); return; }
      const hh = headerHash(b);
      rows.push({ operator: e.operator, url: e.url, hash: String(b.hash).toLowerCase(), stateRoot: String(b.stateRoot).toLowerCase(), headerSelfConsistent: hh.ok });
    } catch (err) { rows.push({ operator: e.operator, url: e.url, hash: null, note: String(err.message).slice(0, 60) }); }
  }));
  const want = String(primaryHash).toLowerCase();
  const answered = rows.filter((r) => r.hash);
  const agree = answered.filter((r) => r.hash === want);
  return {
    asked: rows.length + 1,
    answered: answered.length + 1,
    agree: agree.length + 1,
    disagree: answered.filter((r) => r.hash !== want).map((r) => ({ operator: r.operator, hash: r.hash })),
    operators: [primaryUrl, ...agree.map((r) => r.url)],
    sources: rows,
    meaning: 'Operator agreement on a blockHash. NOT a proof of canonicity, it raises the cost of a forgery from one compromised endpoint to all of them, and nothing more.',
  };
}

// ---------------------------------------------------------------------------------------------
// calldata-x: the address-reputation and proxy quantities, anchored.
//
// These are the ones that come out BEST, and it is worth being precise about why: calldata-x's
// spender verdict does not rest on a derived aggregate or an off-chain quote, it rests on three
// things that are literally fields of the account leaf and of the storage trie:
//   • contract-vs-EOA   -> account.codeHash (EOA iff keccak256('') )
//   • codeSizeBytes     -> the code preimage, bound to the PROVEN codeHash
//   • outboundTxCount   -> account.nonce, verbatim
//   • proxy impl/beacon -> three EIP-1967/zeppelinos storage slots, INCLUDING the empty case
// So the DANGER verdict "unlimited approval to a wallet, not a contract" becomes a Merkle-anchored
// statement rather than a node's opinion.

// Same three constants calldataX.js uses. Duplicated deliberately: src/engine/ must not be imported
// from here (it is hash-frozen), so these are re-stated and pinned by a gate assertion instead.
export const PROXY_SLOTS = {
  'eip1967.implementation': '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  'eip1967.beacon': '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  'zeppelinos.implementation': '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
};

/**
 * Anchor the account-level quantities calldata-x reports about a spender or target.
 * `withCode: true` also fetches eth_getCode and binds it to the PROVEN codeHash, without that step
 * "codeSizeBytes" is still just the node's word, even though codeHash is proven.
 */
export async function anchorAddress({ chain = 'ethereum', address, block, withCode = true, corroborate = true, endpoint = null } = {}) {
  const slots = Object.values(PROXY_SLOTS);
  const a = await anchorState({ chain, address, slots, block, corroborate, endpoint });
  if (!a.ok) return a;

  const readSlot = (hex) => {
    const norm = '0x' + BigInt(hex).toString(16);
    return a.slots[norm];
  };
  const proxy = { isProxy: false, standard: null, implementation: null, provenSlots: {} };
  for (const [name, slotHex] of Object.entries(PROXY_SLOTS)) {
    const s = readSlot(slotHex);
    if (!s) return { ok: false, reason: `no proof returned for ${name} slot, refusing a partial proxy verdict` };
    proxy.provenSlots[name] = { value: '0x' + s.value.toString(16), proofKind: s.kind };
    if (s.value !== 0n && !proxy.isProxy) {
      proxy.isProxy = true;
      proxy.standard = name;
      proxy.implementation = '0x' + s.value.toString(16).padStart(64, '0').slice(24);
    }
  }
  // "not a proxy" is only sound if every slot came back as a VERIFIED exclusion (or a proven zero).
  // An unverified absence would let a malicious node hide an upgradeable implementation by simply
  // omitting the proof, which is exactly the failure calldata-x's UPGRADEABLE_PROXY_TARGET flag exists
  // to catch, so it is not allowed to be silent here.
  const allProven = Object.values(proxy.provenSlots).every((p) => p.proofKind === 'inclusion' || p.proofKind === 'exclusion');
  if (!allProven) return { ok: false, reason: 'a proxy slot was neither proven present nor proven absent, refusing to report "not a proxy"' };

  let codeCheck = null;
  let delegated = false;
  if (withCode) {
    if (a.account.isEoa) {
      codeCheck = { ok: true, sizeBytes: 0, note: 'proven EOA: codeHash == keccak256(empty), so no code preimage exists to fetch' };
    } else {
      try {
        const tag = '0x' + a.block.number.toString(16);
        const { result: codeHex } = await callRetry(a.endpoint, 'eth_getCode', [address, tag]);
        const h = keccak256(codeHex || '0x').toLowerCase();
        if (h !== a.account.codeHash) {
          return { ok: false, reason: `eth_getCode returned bytecode hashing to ${h.slice(0, 14)}… but the PROVEN account codeHash is ${a.account.codeHash.slice(0, 14)}…, the node served code that is not this account's code. Refusing.` };
        }
        // EIP-7702: a delegated wallet carries exactly 23 bytes of 0xef0100 || address. Its codeHash is
        // NOT the empty hash, so `isEoa` is false and a naive reading calls it a contract. calldataX.js
        // draws this distinction on purpose, its DANGER verdict for "unlimited approval to a wallet,
        // not a protocol contract" keys on it, so an anchor that collapsed 7702 into "contract" would
        // quietly downgrade the exact alert it exists to support. Caught by measuring vitalik.eth,
        // which came back tier=contract with 23 bytes of code.
        delegated = /^0xef0100[0-9a-f]{40}$/i.test(String(codeHex || ''));
        codeCheck = { ok: true, sizeBytes: (codeHex.length - 2) / 2, boundTo: 'proven codeHash', delegatedTo: delegated ? '0x' + codeHex.slice(8) : null, note: 'keccak256(eth_getCode) == proven account codeHash, so the bytecode (and its size, and any 7702 delegation it encodes) inherits the account proof' };
      } catch (e) { return { ok: false, transport: !!e.transport, reason: `eth_getCode failed, so codeSizeBytes cannot be bound to the proven codeHash: ${String(e.message).slice(0, 90)}` }; }
    }
  }

  const tier = a.account.absent ? 'absent'
    : a.account.isEoa ? 'eoa'
    : delegated ? 'eoa7702'
    : withCode ? 'contract'
    : 'contract-or-eoa7702';   // without the code preimage the two are indistinguishable; say so

  return {
    ...a,
    reputation: {
      tier,
      delegated,
      outboundTxCount: Number(a.account.nonce),
      codeSizeBytes: codeCheck?.sizeBytes ?? null,
      balanceWei: a.account.balance.toString(),
      proxy,
      code: codeCheck,
      anchored: 'tier, outboundTxCount, balance and every proxy slot are read from the Merkle-verified account leaf and storage trie at this block, not from an eth_call the node could answer freely.',
    },
  };
}

export const _internal = { decodePath, nibblesOf, decodeStorageLeaf, decodeAccountLeaf, normField, call, headerHash };
