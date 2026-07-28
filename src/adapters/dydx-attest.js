// dYdX v4 INPUT ATTESTATION — verify what the indexer told us against the chain's own committed state.
//
// The existing adapter (`dydx.js`) reads https://indexer.dydx.trade over plain HTTPS. That response
// carries no signature of any kind (measured: PHASE_D_RESEARCH.md §2). This module independently
// fetches the same quantities out of dYdX's raw application store via a CometBFT `abci_query` with
// `prove=true`, verifies the returned ICS-23 proof, and reports agreement — or REFUSES.
//
// ============================================================================================
// THE TRUST CHAIN, STATED EXACTLY. Read this before quoting anything this module returns.
// ============================================================================================
//
// What is verified, end to end, and reproducible by `npm run gate:d3`:
//
//   1. ics23:iavl    — the (key, value) pair hashes into a store root. Recomputed locally, and every
//                      leaf/inner op is checked against the pinned IAVL spec before it is used.
//   2. ics23:simple  — that store root hashes into `app_hash`, again recomputed locally.
//   3. app_hash      — equals the `app_hash` field of the CometBFT header at height H+1.
//   4. header hash   — that header's 14-field Merkle hash equals `commit.block_id.hash`, so the
//                      app_hash is bound into the block ID the commit claims to be voting on.
//   5. validator set — the validator set returned for that height hashes to `header.validators_hash`.
//   6. SIGNATURES    — every precommit in that commit is ed25519-verified against the signing
//                      validator's public key over CometBFT `CanonicalVote` sign bytes, and the
//                      verified voting power must exceed 2/3 of the set. This is the step that makes
//                      the app_hash consensus-rooted rather than merely RPC-asserted.
//   7. corroboration — steps 3-6 are repeated against N INDEPENDENTLY OPERATED public RPC endpoints
//                      (different companies, different infrastructure) and every one must return the
//                      same chain id, block hash and app_hash for that height.
//
// So the honest one-line description of a successful attestation is:
//     "this value is in dYdX's state tree under an app_hash bound into a block that more than 2/3 of
//      the voting power of the validator set named by that block signed for"
//
// What is STILL NOT verified, and this is the part that matters:
//
//   * THERE IS NO TRUSTED CHECKPOINT. The validator set is fetched from the same RPC and checked
//     against `header.validators_hash` — which lives in the header that same RPC served. That is
//     internally consistent but circular: a malicious provider could invent a validator set of its
//     own keys, sign a fabricated block with them, and every check 1-6 would pass. Closing this
//     needs a weak-subjectivity checkpoint (a block hash / validator-set hash obtained out of band
//     and pinned), which this module does NOT have.
//   * Corroboration is therefore load-bearing, not decoration: it is what forces that attack to
//     require collusion across three separately operated providers. `MIN_CORROBORATORS` is 2 and the
//     module refuses below that rather than silently degrading to a single source.
//   * Freshness is not attested. Even with every provider honest they can withhold, delay, or choose
//     which of several recent heights to serve.
//   * Nothing here says dYdX's oracle price is CORRECT. It says the chain committed to it. A
//     manipulated oracle is attested with full force. Attestation is provenance, never truth.
//
// ============================================================================================
// WHAT THIS DISAGREES WITH IN PHASE_D_RESEARCH.md §4.2
// ============================================================================================
//   * The perpetuals-store key prefix is `Perp:`, NOT `Perpetual:`. `Perpetual:` + be4(0) returns a
//     NON-existence proof on mainnet today (measured). §4.2 never queried it — it only did `Price:`
//     and `LiqTier:` — so the doc does not state the wrong prefix, but anything built from its
//     naming would miss. The neighbour-decoding trick §4.2 describes is what recovered it: the left
//     neighbour of `Perpetual:`+be4(0) is `Perp:`+be4(392).
//   * §4.2 attests maintenance margin by reading `LiqTier:`+be4(0) directly. That is only correct for
//     markets that happen to use liquidity tier 0. The market -> tier mapping lives in the Perpetual,
//     so a real attestation needs THREE proofs (Perp -> Price, Perp -> LiqTier), not one.
//   * §4.2's title says "validator-signed header". An earlier draft of THIS file called that wrong and
//     recorded signature verification as unreachable. The earlier draft was the thing that was wrong.
//     The defect was in its own encoder: CometBFT `CanonicalVote` is proto3, so a default-valued
//     scalar is omitted from the wire, and `round` is 0 in the overwhelming majority of blocks. The
//     old encoder emitted an explicit zero `round`, which changes the signed bytes and fails every
//     signature. Emitting it only when non-zero verifies 100% of present precommits. Measured after
//     the fix: 0 signature failures at five heights spanning 50,000 blocks, 89-95% of voting power,
//     identical from all three providers. §4.2's title is correct; the doubt cast on it was not.
//
// Nothing in this file is served, deployed, or on chain. It lives outside src/engine/.
import { verifyStoreProof, pbFields, pbFirst, zigzag, uvarintEnc } from './ics23.js';
import { createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto';

// Three independently operated public endpoints. Measured 2026-07-28: all three serve ICS-23 proofs
// on the raw store path. Others tried and rejected, with the reason, so nobody re-tries them blind:
//   blastapi / lavenderfive / nodeshub / stakeandrelax / nodestake  -> DNS or connection failure
//   ecostake -> HTTP 525, cosmos-spaces -> HTML not JSON, autostake / nuxian -> 404, noders -> 405
export const DYDX_RPCS = [
  'https://dydx-rpc.publicnode.com',
  'https://dydx-ops-rpc.kingnodes.com',
  'https://dydx-dao-rpc.polkachu.com',
];
export const DYDX_INDEXER = 'https://indexer.dydx.trade/v4/perpetualMarkets';
export const DYDX_CHAIN_ID = 'dydx-mainnet-1';

// A proof needs the header at H+1 to exist, so never query the tip. 3 blocks is ~4 s on dYdX.
const PROOF_LAG = 3;
// Below two independent providers the corroboration step is vacuous, and a single-source "attestation"
// is exactly the overclaim this module exists to avoid. Refuse instead.
export const MIN_CORROBORATORS = 2;

const be4 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const sha256 = (b) => createHash('sha256').update(b).digest();

// Store keys, recovered from neighbour leaves of non-existence proofs rather than from documentation
// (dYdX documents none of this). Each is a prefix followed by a big-endian uint32 id.
export const KEYS = {
  price: (marketId) => Buffer.concat([Buffer.from('Price:'), be4(marketId)]),
  perpetual: (perpetualId) => Buffer.concat([Buffer.from('Perp:'), be4(perpetualId)]),
  liqTier: (tierId) => Buffer.concat([Buffer.from('LiqTier:'), be4(tierId)]),
};
export const STORES = { price: 'prices', perpetual: 'perpetuals', liqTier: 'perpetuals' };

// ---------------------------------------------------------------- quantity registry
//
// The point of a registry is that an unlisted quantity is REFUSED rather than guessed at. Adding a
// row is a deliberate act that has to name the store key it comes from.
export const ATTESTABLE = {
  oraclePrice: { source: 'prices/Price:<marketId>', note: 'MarketPrice.price scaled by MarketPrice.exponent' },
  maintenanceMarginRate: { source: 'perpetuals/LiqTier:<tierId>', note: 'initial_margin_ppm x maintenance_fraction_ppm / 1e12' },
  initialMarginRate: { source: 'perpetuals/LiqTier:<tierId>', note: 'initial_margin_ppm / 1e6' },
  maxLeverage: { source: 'perpetuals/LiqTier:<tierId>', note: '1e6 / initial_margin_ppm' },
};

// Quantities the existing dydx.js adapter returns that CANNOT be attested, with the measured reason.
// `fundingHourly` is the live gap: perp-gate consumes it and nothing here can vouch for it.
export const NOT_ATTESTABLE = {
  fundingHourly:
    'nextFundingRate is not a stored value. The perpetuals store holds PremSamples / PremVotes and a ' +
    'cumulative funding_index inside the Perpetual; the hourly rate the indexer publishes is computed ' +
    'at the hour boundary and never committed under a key. Searched the prices and perpetuals stores ' +
    'by non-existence-proof neighbour walk; not found. Not found is not the same as not there.',
  orderbook:
    'dYdX documents the orderbook as in-memory per node and "not written to the blockchain or stored ' +
    'in the application state", so no depth is ever provable.',
};

// ---------------------------------------------------------------- exact decimal helpers
//
// Doing this in floating point would manufacture divergence that is not there. The chain stores
// integers plus an exponent; the indexer prints a decimal string. Both round-trip exactly through a
// decimal string, so an honest agreement measures as EXACTLY zero and the bound measures drift only.

/** mantissa (BigInt|number) x 10^exponent, via an exact decimal string. */
export function decimalFromScaled(mantissa, exponent) {
  let s = BigInt(mantissa).toString();
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let out;
  if (exponent >= 0) out = s + '0'.repeat(exponent);
  else {
    const d = -exponent;
    if (s.length <= d) s = '0'.repeat(d - s.length + 1) + s;
    out = `${s.slice(0, s.length - d)}.${s.slice(s.length - d)}`;
  }
  return Number((neg ? '-' : '') + out);
}

const relDiff = (a, b) => {
  if (a === b) return 0;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? Infinity : Math.abs(a - b) / scale;
};

// ---------------------------------------------------------------- RPC

async function jrpc(base, method, params, timeoutMs) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${base}: http ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${base}: ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}

// ---------------------------------------------------------------- CometBFT header hashing
//
// Needed for check 4. CometBFT hashes 14 protobuf-encoded header fields into a simple Merkle tree;
// `cdcEncode` wraps scalars in the gogo well-known single-field wrappers and yields NOTHING for an
// empty value, which is why the helpers below return zero-length buffers rather than encoding zeros.

const tagLen = (f, b) => Buffer.concat([uvarintEnc((f << 3) | 2), uvarintEnc(b.length), b]);
const tagVar = (f, n) => Buffer.concat([uvarintEnc((f << 3) | 0), uvarintEnc(n)]);
const cdcBytes = (b) => (b && b.length ? tagLen(1, b) : Buffer.alloc(0));
const cdcString = (s) => (s && s.length ? tagLen(1, Buffer.from(s, 'utf8')) : Buffer.alloc(0));
const cdcInt64 = (n) => (BigInt(n) !== 0n ? tagVar(1, BigInt(n)) : Buffer.alloc(0));
const hx = (s) => (s ? Buffer.from(s, 'hex') : Buffer.alloc(0));

/** RFC3339 with nanoseconds. `new Date()` would silently truncate to milliseconds and break the hash. */
export function timestampProto(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(s);
  if (!m) throw new Error(`dydx-attest: unparseable timestamp ${s}`);
  const seconds = BigInt(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
  const nanos = m[7] ? Number(m[7].padEnd(9, '0').slice(0, 9)) : 0;
  return Buffer.concat([seconds !== 0n ? tagVar(1, seconds) : Buffer.alloc(0), nanos !== 0 ? tagVar(2, BigInt(nanos)) : Buffer.alloc(0)]);
}

function blockIdProto(bid) {
  if (!bid || !bid.hash) return Buffer.alloc(0);
  const psh = Buffer.concat([
    bid.parts?.total ? tagVar(1, BigInt(bid.parts.total)) : Buffer.alloc(0),
    bid.parts?.hash ? tagLen(2, hx(bid.parts.hash)) : Buffer.alloc(0),
  ]);
  return Buffer.concat([tagLen(1, hx(bid.hash)), tagLen(2, psh)]);
}

const leafHash = (b) => sha256(Buffer.concat([Buffer.from([0]), b]));
const innerHash = (l, r) => sha256(Buffer.concat([Buffer.from([1]), l, r]));
function splitPoint(n) { let k = 1; while (k * 2 < n) k *= 2; return k; }
function merkleRoot(items) {
  if (items.length === 0) return sha256(Buffer.alloc(0));
  if (items.length === 1) return leafHash(items[0]);
  const k = splitPoint(items.length);
  return innerHash(merkleRoot(items.slice(0, k)), merkleRoot(items.slice(k)));
}

export function headerHash(h) {
  const version = Buffer.concat([
    h.version?.block ? tagVar(1, BigInt(h.version.block)) : Buffer.alloc(0),
    h.version?.app ? tagVar(2, BigInt(h.version.app)) : Buffer.alloc(0),
  ]);
  return merkleRoot([
    version, cdcString(h.chain_id), cdcInt64(h.height), timestampProto(h.time),
    blockIdProto(h.last_block_id), cdcBytes(hx(h.last_commit_hash)), cdcBytes(hx(h.data_hash)),
    cdcBytes(hx(h.validators_hash)), cdcBytes(hx(h.next_validators_hash)), cdcBytes(hx(h.consensus_hash)),
    cdcBytes(hx(h.app_hash)), cdcBytes(hx(h.last_results_hash)), cdcBytes(hx(h.evidence_hash)),
    cdcBytes(hx(h.proposer_address)),
  ]).toString('hex').toUpperCase();
}

export function validatorSetHash(validators) {
  return merkleRoot(validators.map((v) => {
    const raw = Buffer.from(v.pub_key.value, 'base64');
    return Buffer.concat([tagLen(1, tagLen(1, raw)), tagVar(2, BigInt(v.voting_power))]);
  })).toString('hex').toUpperCase();
}

// ---------------------------------------------------------------- the signature step
//
// CometBFT `CanonicalVote` sign bytes: type / height(sfixed64) / round(sfixed64) / block_id /
// timestamp / chain_id, marshalled then uvarint length-delimited, ed25519-verified per precommit.
//
// THE ONE SUBTLETY, and it silently defeats the whole light client if you miss it: CanonicalVote is
// proto3, and proto3 OMITS a scalar field whose value is the type default. `round` is 0 in the
// overwhelming majority of blocks, so the correct sign bytes contain NO round field at all. An
// encoder that dutifully writes an explicit zero `round` (tag 0x19 + eight zero bytes) produces
// bytes nobody signed and verifies exactly nothing — while looking completely reasonable, and while
// failing in the same way on every CometBFT chain, which makes it read like a property of the chains
// rather than a bug at home. `fx()` below returns an empty buffer for zero, which is the fix.
//
// This was found by fixing the honest measurement and searching the encoding space rather than by
// reasoning: 432 candidate encodings over 7 axes were tried against real precommits and exactly one
// verified. Everything is checked against tamper mutations too (gateD3), because a signature checker
// that cannot reject is worth nothing.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SIGNED_MSG_TYPE_PRECOMMIT = 2;
/** Two-thirds is the CometBFT safety threshold: strictly greater than 2/3 of total voting power. */
export const POWER_THRESHOLD_NUM = 2n, POWER_THRESHOLD_DEN = 3n;

/** proto3 sfixed64: emitted only when non-zero. The zero case is why the old encoder verified nothing. */
const fixed64 = (field, n) => {
  if (BigInt(n) === 0n) return Buffer.alloc(0);
  const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n));
  return Buffer.concat([Buffer.from([(field << 3) | 1]), b]);
};

export function voteSignBytes({ chainId, height, round, blockId, timestamp }) {
  const canonicalBlockId = Buffer.concat([
    tagLen(1, hx(blockId.hash)),
    tagLen(2, Buffer.concat([tagVar(1, BigInt(blockId.parts.total)), tagLen(2, hx(blockId.parts.hash))])),
  ]);
  const body = Buffer.concat([
    tagVar(1, BigInt(SIGNED_MSG_TYPE_PRECOMMIT)),
    fixed64(2, height),
    fixed64(3, round),
    tagLen(4, canonicalBlockId),
    tagLen(5, timestampProto(timestamp)),
    tagLen(6, Buffer.from(chainId, 'utf8')),
  ]);
  return Buffer.concat([uvarintEnc(body.length), body]);
}

/**
 * ed25519-verify every precommit in a commit against the validator set.
 *
 * `absent` (block_id_flag != 2) is normal and not an error — validators miss blocks. What matters is
 * that the VERIFIED voting power exceeds 2/3, which is the property `twoThirds` reports. A signature
 * that is present but does not verify is counted in `failed` and is never tolerated by the caller.
 */
export function verifyCommitSignatures({ header, commit, validators }) {
  const byAddr = new Map(validators.map((v) => [v.address, v]));
  let verified = 0, failed = 0, absent = 0, unmapped = 0, power = 0n, totalPower = 0n;
  for (const v of validators) totalPower += BigInt(v.voting_power);
  for (const s of commit.signatures) {
    if (s.block_id_flag !== 2 || !s.signature) { absent++; continue; }
    const v = byAddr.get(s.validator_address);
    if (!v) { unmapped++; continue; }
    const msg = voteSignBytes({ chainId: header.chain_id, height: commit.height, round: commit.round, blockId: commit.block_id, timestamp: s.timestamp });
    let ok = false;
    try {
      const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(v.pub_key.value, 'base64')]), format: 'der', type: 'spki' });
      ok = ed25519Verify(null, msg, key, Buffer.from(s.signature, 'base64'));
    } catch { ok = false; }
    if (ok) { verified++; power += BigInt(v.voting_power); } else failed++;
  }
  const twoThirds = totalPower > 0n && power * POWER_THRESHOLD_DEN > totalPower * POWER_THRESHOLD_NUM;
  return {
    verified, failed, absent, unmapped,
    power: String(power), totalPower: String(totalPower),
    powerFraction: totalPower > 0n ? Number((power * 1000000n) / totalPower) / 1000000 : 0,
    twoThirds, achieved: twoThirds && failed === 0,
  };
}

// ---------------------------------------------------------------- the state anchor

export const TRUST = {
  // What this module reaches today: signatures verified, >2/3 power, corroborated across providers.
  // It is deliberately NOT called "consensus-verified" without qualification, because there is no
  // trusted checkpoint pinning the validator set (see the header). This is the honest middle label.
  SIGNED: 'ics23-verified-against-a-2/3-validator-signed-app_hash-corroborated-by-N-independent-rpcs',
  // The weaker label, returned when signature checking was explicitly disabled by the caller.
  CORROBORATED: 'ics23-verified-against-an-app_hash-corroborated-by-N-independent-rpcs',
  // What this would be with a weak-subjectivity checkpoint pinning the validator set. Never returned.
  CHECKPOINTED: 'ics23-verified-against-a-signed-app_hash-anchored-to-a-trusted-checkpoint',
};

/**
 * Pin one height and obtain the app_hash for it from several independent providers.
 * Every proof in an attestation roots into THIS app_hash, so one anchor covers a whole batch.
 */
export async function openAnchor({ rpcs = DYDX_RPCS, timeoutMs = 15000, checkValidatorSet = true } = {}) {
  const t0 = Date.now();
  const statuses = await Promise.allSettled(rpcs.map((r) => jrpc(r, 'status', {}, timeoutMs).then((s) => ({ rpc: r, s }))));
  const live = statuses.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (live.length < MIN_CORROBORATORS) {
    throw new Error(`dydx-attest: only ${live.length} of ${rpcs.length} RPCs answered; need ${MIN_CORROBORATORS} independent providers to corroborate a root`);
  }
  for (const { rpc, s } of live) {
    if (s.node_info.network !== DYDX_CHAIN_ID) throw new Error(`dydx-attest: ${rpc} reports chain ${s.node_info.network}, expected ${DYDX_CHAIN_ID}`);
  }
  const height = Math.min(...live.map(({ s }) => Number(s.sync_info.latest_block_height))) - PROOF_LAG;

  // app_hash for the state AFTER block `height` appears in the header of block height+1.
  const commits = await Promise.allSettled(live.map(({ rpc }) => jrpc(rpc, 'commit', { height: String(height + 1) }, timeoutMs).then((c) => ({ rpc, c }))));
  const got = commits.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (got.length < MIN_CORROBORATORS) throw new Error(`dydx-attest: only ${got.length} RPCs served the header at ${height + 1}; need ${MIN_CORROBORATORS}`);

  const primary = got[0];
  const header = primary.c.signed_header.header;
  const commit = primary.c.signed_header.commit;

  // Check 4: the app_hash is inside the header that hashes to the block ID the commit votes on.
  const computedBlockHash = headerHash(header);
  if (computedBlockHash !== commit.block_id.hash) {
    throw new Error(`dydx-attest: header hash ${computedBlockHash} != commit.block_id.hash ${commit.block_id.hash}`);
  }

  // Check 6: every other provider must report the same block for this height.
  const disagreements = [];
  for (const g of got.slice(1)) {
    const h = g.c.signed_header.header;
    if (h.app_hash !== header.app_hash) disagreements.push(`${g.rpc}: app_hash ${h.app_hash}`);
    else if (g.c.signed_header.commit.block_id.hash !== commit.block_id.hash) disagreements.push(`${g.rpc}: block_id ${g.c.signed_header.commit.block_id.hash}`);
    else if (h.chain_id !== header.chain_id) disagreements.push(`${g.rpc}: chain ${h.chain_id}`);
  }
  if (disagreements.length) throw new Error(`dydx-attest: RPC providers disagree on height ${height + 1}: ${disagreements.join('; ')}`);

  // Check 5: the validator set named by the header is the one served.
  let validatorSet = null;
  let signatures = null;
  if (checkValidatorSet) {
    const vs = await jrpc(primary.rpc, 'validators', { height: String(height + 1), per_page: '200' }, timeoutMs);
    const computed = validatorSetHash(vs.validators);
    if (computed !== header.validators_hash) {
      throw new Error(`dydx-attest: validator set hashes to ${computed}, header says ${header.validators_hash}`);
    }
    validatorSet = vs.validators;

    // Check 6: the precommits actually verify, and carry more than 2/3 of the voting power. Without
    // this the app_hash is only RPC-asserted; with it, it is signed. Refuse rather than downgrade.
    signatures = verifyCommitSignatures({ header, commit, validators: validatorSet });
    if (signatures.failed > 0) {
      throw new Error(`dydx-attest: ${signatures.failed} precommit signature(s) present but INVALID at height ${height + 1} — refusing`);
    }
    if (!signatures.twoThirds) {
      throw new Error(`dydx-attest: only ${(signatures.powerFraction * 100).toFixed(2)}% of voting power verified at height ${height + 1}; need >66.67%`);
    }
  }

  return {
    chainId: header.chain_id,
    height,                                 // the height the proofs are taken at
    headerHeight: Number(header.height),    // height+1, where app_hash lives
    appHash: header.app_hash,
    blockHash: computedBlockHash,
    validatorsHash: header.validators_hash,
    validatorCount: validatorSet?.length ?? null,
    time: header.time,
    providers: got.map((g) => g.rpc),
    corroborators: got.length,
    primary: primary.rpc,
    trust: signatures ? TRUST.SIGNED : TRUST.CORROBORATED,
    signaturesVerified: !!signatures?.achieved,
    signatures,                              // { verified, failed, absent, powerFraction, twoThirds }
    _header: header,
    _commit: commit,
    _validators: validatorSet,
    ms: Date.now() - t0,
  };
}

/**
 * Fetch and verify one raw-store key at the anchor's height. Returns { value, storeRoot, bytes }.
 * Throws if the proof is absent, is a non-existence proof, fails its spec, or roots into a different
 * app_hash than the anchor's — that last clause is the one that catches a proof lifted from another
 * height, which is the cheapest forgery available to a node that has real proofs for real states.
 */
export async function proveKey(anchor, store, key, { timeoutMs = 15000, rpc } = {}) {
  const endpoint = rpc || anchor.primary;
  const r = (await jrpc(endpoint, 'abci_query', {
    path: `/store/${store}/key`, data: Buffer.from(key).toString('hex'), height: String(anchor.height), prove: true,
  }, timeoutMs)).response;

  if (r.code && Number(r.code) !== 0) throw new Error(`dydx-attest: abci_query code ${r.code} ${r.log || ''}`);
  if (Number(r.height) !== anchor.height) throw new Error(`dydx-attest: response height ${r.height} != anchor height ${anchor.height}`);
  if (!r.value) throw new Error(`dydx-attest: no value at ${store}/${Buffer.from(key).toString('latin1')} — the key does not exist in state`);
  const ops = r.proofOps?.ops;
  if (!ops?.length) throw new Error(`dydx-attest: node returned no proof for ${store}/${Buffer.from(key).toString('latin1')}`);

  const value = Buffer.from(r.value, 'base64');
  const { appRoot, storeRoot, bytes, depth } = verifyStoreProof({ ops, store, key, value });
  const appRootHex = appRoot.toString('hex').toUpperCase();
  if (appRootHex !== anchor.appHash) {
    throw new Error(`dydx-attest: proof roots to ${appRootHex} but the anchored app_hash at height ${anchor.height} is ${anchor.appHash}`);
  }
  return { value, storeRoot: storeRoot.toString('hex').toUpperCase(), bytes, depth };
}

// ---------------------------------------------------------------- protobuf value decoders

/** dydxprotocol.prices.MarketPrice { uint32 id=1; sint32 exponent=2; uint64 price=3 } */
export function decodeMarketPrice(buf) {
  const fs = pbFields(buf);
  const exponent = Number(zigzag(pbFirst(fs, 2)?.varint ?? 0n));
  const raw = pbFirst(fs, 3)?.varint ?? 0n;
  return { id: Number(pbFirst(fs, 1)?.varint ?? 0n), exponent, raw: String(raw), price: decimalFromScaled(raw, exponent) };
}

/** dydxprotocol.perpetuals.Perpetual { PerpetualParams params=1; bytes funding_index=2; bytes open_interest=3 } */
export function decodePerpetual(buf) {
  const fs = pbFields(buf);
  const p = pbFirst(fs, 1);
  if (!p) throw new Error('dydx-attest: Perpetual has no params');
  const q = pbFields(p.bytes);
  return {
    id: Number(pbFirst(q, 1)?.varint ?? 0n),
    ticker: pbFirst(q, 2)?.bytes?.toString('utf8') ?? null,
    marketId: Number(pbFirst(q, 3)?.varint ?? 0n),
    atomicResolution: Number(zigzag(pbFirst(q, 4)?.varint ?? 0n)),
    defaultFundingPpm: Number(zigzag(pbFirst(q, 5)?.varint ?? 0n)),
    liquidityTier: Number(pbFirst(q, 6)?.varint ?? 0n),
    marketType: Number(pbFirst(q, 7)?.varint ?? 0n),
  };
}

/** dydxprotocol.perpetuals.LiquidityTier { id=1; name=2; initial_margin_ppm=3; maintenance_fraction_ppm=4; ... } */
export function decodeLiquidityTier(buf) {
  const fs = pbFields(buf);
  const imPpm = Number(pbFirst(fs, 3)?.varint ?? 0n);
  const mfPpm = Number(pbFirst(fs, 4)?.varint ?? 0n);
  if (!(imPpm > 0) || !(mfPpm > 0)) throw new Error('dydx-attest: liquidity tier has no margin ppm fields');
  return {
    id: Number(pbFirst(fs, 1)?.varint ?? 0n),
    name: pbFirst(fs, 2)?.bytes?.toString('utf8') ?? null,
    initialMarginPpm: imPpm,
    maintenanceFractionPpm: mfPpm,
    initialMarginRate: decimalFromScaled(imPpm, -6),
    // maintenance margin FRACTION of notional = IM x maintenance fraction. Exact in integer ppm space.
    maintenanceMarginRate: decimalFromScaled(BigInt(imPpm) * BigInt(mfPpm), -12),
    maxLeverage: Math.round((1e6 / imPpm) * 100) / 100,
  };
}

// ---------------------------------------------------------------- indexer side

export async function fetchIndexerMarkets({ timeoutMs = 15000 } = {}) {
  const res = await fetch(DYDX_INDEXER, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`dydx indexer ${res.status}`);
  const j = await res.json();
  if (!j?.markets) throw new Error('dydx-attest: unexpected indexer shape');
  return j.markets;
}

const normTicker = (s) => {
  const t = String(s || '').toUpperCase();
  return t.includes('-') ? t : `${t}-USD`;
};

// ---------------------------------------------------------------- the attestation

/**
 * Prove one market's on-chain parameters at the anchor. Three proofs:
 *   Perp:<perpetualId>  -> the ticker (checked), the market id, the liquidity tier
 *   Price:<marketId>    -> the oracle price
 *   LiqTier:<tierId>    -> initial / maintenance margin
 *
 * `perpetualId` is taken from the indexer's `clobPairId`. That mapping is an ASSUMPTION, so it is
 * VERIFIED rather than trusted: the on-chain ticker must equal the ticker the caller asked about, and
 * the whole attestation is refused if it does not.
 */
export async function proveMarket(anchor, { ticker, perpetualId, timeoutMs = 15000 }) {
  const want = normTicker(ticker);
  const perpProof = await proveKey(anchor, STORES.perpetual, KEYS.perpetual(perpetualId), { timeoutMs });
  const perp = decodePerpetual(perpProof.value);
  if (normTicker(perp.ticker) !== want) {
    throw new Error(`dydx-attest: Perp:${perpetualId} is ticker "${perp.ticker}" on chain, not "${want}" — refusing rather than guessing the id mapping`);
  }
  const [priceProof, tierProof] = await Promise.all([
    proveKey(anchor, STORES.price, KEYS.price(perp.marketId), { timeoutMs }),
    proveKey(anchor, STORES.liqTier, KEYS.liqTier(perp.liquidityTier), { timeoutMs }),
  ]);
  const price = decodeMarketPrice(priceProof.value);
  if (price.id !== perp.marketId && price.id !== 0) {
    throw new Error(`dydx-attest: MarketPrice under Price:${perp.marketId} reports id ${price.id}`);
  }
  const tier = decodeLiquidityTier(tierProof.value);
  return {
    ticker: perp.ticker,
    perp,
    tier,
    proven: {
      oraclePrice: price.price,
      maintenanceMarginRate: tier.maintenanceMarginRate,
      initialMarginRate: tier.initialMarginRate,
      maxLeverage: tier.maxLeverage,
    },
    proofBytes: perpProof.bytes + priceProof.bytes + tierProof.bytes,
    proofs: { perp: perpProof.bytes, price: priceProof.bytes, tier: tierProof.bytes },
  };
}

/**
 * The top-level check: does a value the indexer handed us agree with the chain's own state?
 *
 * Returns a verdict object and never throws for data reasons. `ok:false` with a `reason` is a REFUSAL
 * and must be treated as one — there is deliberately no "probably fine" branch.
 */
export async function attest({ ticker, perpetualId, quantity, claimed, bound, anchor, market, timeoutMs = 15000 }) {
  const base = { quantity, ticker: normTicker(ticker), claimed, bound };

  if (NOT_ATTESTABLE[quantity]) {
    return { ...base, ok: false, status: 'REFUSED', reason: 'NO_PROOF_PATH', detail: NOT_ATTESTABLE[quantity] };
  }
  if (!ATTESTABLE[quantity]) {
    return { ...base, ok: false, status: 'REFUSED', reason: 'UNKNOWN_QUANTITY', detail: `no store key is registered for "${quantity}"; attestable: ${Object.keys(ATTESTABLE).join(', ')}` };
  }
  if (!Number.isFinite(claimed)) {
    return { ...base, ok: false, status: 'REFUSED', reason: 'CLAIM_NOT_A_NUMBER', detail: `claimed=${claimed}` };
  }
  if (!(bound > 0)) {
    return { ...base, ok: false, status: 'REFUSED', reason: 'NO_BOUND', detail: 'a divergence bound is required; refusing to invent one' };
  }

  let m = market;
  try {
    if (!m) m = await proveMarket(anchor, { ticker, perpetualId, timeoutMs });
  } catch (e) {
    return { ...base, ok: false, status: 'REFUSED', reason: 'PROOF_FAILED', detail: e.message };
  }

  const proven = m.proven[quantity];
  if (!Number.isFinite(proven)) {
    return { ...base, ok: false, status: 'REFUSED', reason: 'NOT_IN_PROOF', detail: `${quantity} did not decode out of the proven state` };
  }
  const rel = relDiff(claimed, proven);
  const within = rel <= bound;
  return {
    ...base,
    ok: within,
    status: within ? 'ATTESTED' : 'REFUSED',
    reason: within ? null : 'DIVERGENCE_EXCEEDS_BOUND',
    proven,
    relDiff: rel,
    boundUsedPct: (rel / bound) * 100,
    source: ATTESTABLE[quantity].source,
    proofBytes: m.proofBytes,
    trust: anchor.trust,
    signaturesVerified: anchor.signaturesVerified,
    chain: { chainId: anchor.chainId, height: anchor.height, appHash: anchor.appHash, blockHash: anchor.blockHash, corroborators: anchor.corroborators, providers: anchor.providers },
  };
}

/**
 * Attest a whole `dydxContext()` result: every field the existing adapter returns, each either
 * ATTESTED or REFUSED with a reason. `fundingHourly` is always refused, on purpose — perp-gate uses
 * it and nothing here can vouch for it, and a silent omission would read as coverage.
 */
export async function attestContext({ symbol, context, anchor, bounds, perpetualId, timeoutMs = 15000 }) {
  const ticker = normTicker(symbol);
  const fields = { markPx: 'oraclePrice', maintMarginRate: 'maintenanceMarginRate', maxLeverage: 'maxLeverage', fundingHourly: 'fundingHourly' };
  let market = null, marketError = null;
  try { market = await proveMarket(anchor, { ticker, perpetualId, timeoutMs }); } catch (e) { marketError = e.message; }

  const out = {};
  for (const [ctxKey, quantity] of Object.entries(fields)) {
    const claimed = context?.[ctxKey];
    if (marketError && !NOT_ATTESTABLE[quantity]) {
      out[ctxKey] = { quantity, ok: false, status: 'REFUSED', reason: 'PROOF_FAILED', detail: marketError, claimed };
      continue;
    }
    out[ctxKey] = await attest({ ticker, perpetualId, quantity, claimed, bound: bounds?.[quantity], anchor, market, timeoutMs });
  }
  const attested = Object.values(out).filter((v) => v.ok).length;
  return { ticker, fields: out, attested, total: Object.keys(fields).length, trust: anchor.trust, chain: { height: anchor.height, appHash: anchor.appHash, corroborators: anchor.corroborators } };
}
