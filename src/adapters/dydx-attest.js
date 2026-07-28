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
// FUNDING IS NOT STORED, AND IS ATTESTED ANYWAY
// ============================================================================================
// The funding rate is the one quantity here that is RECOMPUTED rather than read. dYdX commits no
// funding-rate key; it commits every input to one, and the aggregation over them is deterministic
// integer arithmetic. So steps 1-7 above cover the INPUTS, and the rate follows from them by a rule
// transcribed from `MaybeProcessNewFundingTickEpoch`. See the FUNDING section further down for the
// arithmetic and `FUNDING_CAVEATS` for what a green gate still does not say — chiefly that the
// premium samples originate in each validator's in-memory orderbook, so this proves the chain applied
// its own rule to its own committed inputs and never that those inputs describe a real book.
//
// ============================================================================================
// WHAT THIS DISAGREES WITH IN PHASE_D_RESEARCH.md §4.2, AND WITH PHASE_D_FUNDING.md §3
// ============================================================================================
//   * PHASE_D_FUNDING.md §3 gives the PREDICTED rate as
//         nextFundingRate = sum(PremSamples[perp]) / NumPremiums / 8e6
//     and reports it at 18 of 18 markets, worst relative error 2.7e-14. The formula is INCOMPLETE:
//     it omits `default_funding_ppm`. Measured here across all 296 dYdX markets at one anchored
//     height, that formula reproduces 102 of 296 — and every one of those 102 is a market where BOTH
//     terms are zero, so it reproduces nothing but zeros. 182 markets carry default_funding_ppm = 100
//     and publish exactly 1.25e-5 per hour with no premium samples at all; the omitting formula
//     returns 0 for every one of them. With the term restored: 284 of 296 at the same instant, the
//     residual 12 being the sampled markets and a snapshot-height difference, not a formula error.
//     The 18/18 is explained rather than contradicted: the markets that carry premium samples are the
//     majors, and every one of them has default_funding_ppm = 0, so the missing term vanished across
//     the whole sample it was validated on. PHASE_D_FUNDING.md names that exact failure mode in its
//     own account of the refusal this code replaces — "a formula validated only where one of its
//     terms vanishes has not been validated" — and then reintroduces it one section later.
//     The TICK rule in the same document is correct and already contains the term.
//   * PHASE_D_FUNDING.md's 144-of-144 covered 12 markets, all with default_funding_ppm = 0, so the
//     default-funding branch of the tick rule was unexercised there. gateD3 now asserts coverage of
//     both branches rather than hoping the sample happens to have it.
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
import { verifyStoreProof, pbFields, pbFirst, zigzag, uvarintEnc, uvarints } from './ics23.js';
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
// Attesting a REALIZED funding tick means pinning a height about an hour in the past, and block
// retention is not state retention. Measured 2026-07-28 at tick height 99,349,592: publicnode reports
// 3M blocks of history and still answers `proof is unexpectedly empty; ensure height has not been
// pruned`, while these two serve the proof. Nine other public endpoints were tried and none answered
// at all (DNS failure, HTML error pages, or timeouts), so this list is two entries because two is what
// exists, not because two was chosen. MIN_CORROBORATORS is 2, so both must be up or the module refuses.
export const DYDX_ARCHIVE_RPCS = [
  'https://dydx-ops-rpc.kingnodes.com',
  'https://dydx-dao-rpc.polkachu.com',
];
export const DYDX_INDEXER = 'https://indexer.dydx.trade/v4/perpetualMarkets';
export const DYDX_HISTORICAL_FUNDING = 'https://indexer.dydx.trade/v4/historicalFunding';
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
  // Singletons, no id suffix. `PremSamples` holds EVERY market's premium samples in one value under
  // one key, which is why a single proof covers the whole book and no market's entry can be dropped
  // without breaking that proof.
  premiumSamples: () => Buffer.from('PremSamples'),
  perpetualsParams: () => Buffer.from('Params'),
  epochInfo: (name) => Buffer.concat([Buffer.from('Info:'), Buffer.from(name)]),
};
export const STORES = {
  price: 'prices', perpetual: 'perpetuals', liqTier: 'perpetuals',
  premiumSamples: 'perpetuals', perpetualsParams: 'perpetuals', epochs: 'epochs',
};
export const EPOCH_FUNDING_TICK = 'funding-tick';
export const EPOCH_FUNDING_SAMPLE = 'funding-sample';
/** dYdX quotes funding on an 8-hour convention: the indexer publishes `fundingPpm / 8e6` per hour. */
export const FUNDING_PPM_PER_HOURLY = 8e6;

// ---------------------------------------------------------------- quantity registry
//
// The point of a registry is that an unlisted quantity is REFUSED rather than guessed at. Adding a
// row is a deliberate act that has to name the store key it comes from.
export const ATTESTABLE = {
  oraclePrice: { source: 'prices/Price:<marketId>', note: 'MarketPrice.price scaled by MarketPrice.exponent' },
  maintenanceMarginRate: { source: 'perpetuals/LiqTier:<tierId>', note: 'initial_margin_ppm x maintenance_fraction_ppm / 1e12' },
  initialMarginRate: { source: 'perpetuals/LiqTier:<tierId>', note: 'initial_margin_ppm / 1e6' },
  maxLeverage: { source: 'perpetuals/LiqTier:<tierId>', note: '1e6 / initial_margin_ppm' },
  // The two funding rows. Neither rate is STORED — both are RECOMPUTED from stored inputs, every one
  // of which carries its own ICS-23 existence proof rooting into the same signed app_hash. `source`
  // therefore lists the whole input set, because that is what the attestation actually covers.
  fundingHourly: {
    source: 'perpetuals/PremSamples + perpetuals/Perp:<perpetualId>',
    note: '(sum(premiums, sint32 ppm) / num_premiums + default_funding_ppm) / 8e6 — the running '
      + 'prediction over the partial epoch, which is the number the indexer publishes as '
      + 'nextFundingRate and the only funding number perp-gate consumes. Float division, matching '
      + 'the indexer\'s own non-integer output.',
  },
  fundingTickHourly: {
    source: 'perpetuals/PremSamples + perpetuals/Params + perpetuals/Perp:<perpetualId> '
      + '+ perpetuals/LiqTier:<tierId> + epochs/Info:funding-tick + epochs/Info:funding-sample',
    note: 'MaybeProcessNewFundingTickEpoch, transcribed: clamp(AvgInt32(pad0(premiums, '
      + 'max(num_premiums, tickDur/sampleDur))) + default_funding_ppm, +/- clampFactor x (IM - MM)) '
      + '/ 8e6. Pure integer arithmetic. Equals the venue\'s PUBLISHED realized rate only when the '
      + 'anchor is pinned at effectiveAtHeight-1; at any other height it is the rate the epoch would '
      + 'settle at if the tick fired now, which the venue has not published and nothing can check. '
      + 'proveMarket therefore only exposes it when proveFunding reports tickEpochComplete, and '
      + 'attest refuses it with NOT_IN_PROOF otherwise rather than returning a comparable-looking '
      + 'number that is not comparable to anything.',
  },
};

// Quantities the existing dydx.js adapter returns that CANNOT be attested, with the measured reason.
//
// `fundingHourly` USED TO LIVE HERE. It moved to ATTESTABLE when the recomputation below was wired
// in, which is the whole point of this change: the rate is not stored, and that was never the
// obstacle, because every INPUT to it is a store key carrying an ICS-23 existence proof and the
// aggregation is deterministic. The wire type `repeated sint32` was the actual obstacle. Nothing is
// left here as a placeholder — an entry in this object is a refusal that is currently true.
export const NOT_ATTESTABLE = {
  orderbook:
    'dYdX documents the orderbook as in-memory per node and "not written to the blockchain or stored '
    + 'in the application state", so no depth is ever provable. This is also the ceiling on what the '
    + 'funding attestation means: the premium samples that ARE provable come from each validator\'s '
    + 'MemClob via GetPricePremium, so a verified funding rate proves the chain applied its own rule '
    + 'to its own committed inputs, never that those inputs describe a real book.',
};

// ---------------------------------------------------------------- what the funding proof does NOT say
//
// Stated as data rather than prose so the gate can assert they are still here. Every one of these is
// a limit that survives a fully green gate run.
export const FUNDING_CAVEATS = {
  premiumProvenance:
    'dYdX\'s premium comes from k.MemClob.GetPricePremium — each validator\'s IN-MEMORY orderbook, '
    + 'which the protocol documents as never written to application state. Proposers sample their '
    + 'local book, submit MsgAddPremiumVotes, and the chain medians across the proposers of that '
    + 'minute. So a verified funding rate establishes that the chain applied its own rule correctly '
    + 'to its own committed inputs. It does NOT establish that those inputs describe a real book: a '
    + 'validator set that collectively misreported would produce a rate that verifies perfectly. '
    + 'Attestation is provenance, never truth.',
  clampBranchUnexercised:
    'The clamp in the tick rule is transcribed from source, not observed. For BTC (IM 20,000 ppm, '
    + 'maintenance fraction 600,000 ppm, clamp factor 6,000,000 ppm) the bound works out to '
    + '+/- 48,000 ppm per hour against realized rates of order 100 ppm, so it has never been seen '
    + 'binding on mainnet in any measurement here. gateD3 exercises the branch with a SYNTHETIC '
    + 'input, which proves the code clamps; it does not prove the transcription matches dYdX at the '
    + 'bound, because no on-chain observation reaches it. The same applies to the integer rounding '
    + 'inside the bound: every real liquidity tier divides exactly, so the truncation is unexercised.',
  voteToSampleStage:
    'One stage below this: each premium SAMPLE is itself the median of validator votes in PremVotes, '
    + 'which is also provable. That stage is NOT verified here. PHASE_D_FUNDING.md reproduces it on '
    + '8 of 22 markets, with the cause identified (votes arriving in block H are applied before the '
    + 'end-of-block sample computation, so PremVotes read at H-1 is missing one block of votes) and '
    + 'no fix applied. The attestation therefore starts at the sample, not at the vote.',
  realizedNeedsTickHeight:
    'fundingTickHourly equals a number the venue actually published only when the anchor is pinned at '
    + 'effectiveAtHeight-1 for that tick. That needs an archive provider — measured, dYdX\'s own '
    + 'publicnode endpoint prunes application state and refuses the proof at a height one hour back '
    + 'while still reporting 3M blocks of history. At a live anchor the tick rule returns a '
    + 'hypothetical, and the module labels it as one rather than comparing it to anything.',
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
  // The strongest label, and it is now REACHABLE — `openAnchor({ checkpoint: true })` returns it.
  //
  // Returned if and ONLY if the app_hash every ICS-23 proof roots into is byte-identical to the
  // app_hash a DIFFERENT chain's validators independently committed to, read out of that chain's own
  // IAVL store with its own ICS-23 proof (src/adapters/ibc-checkpoint.js). All six clauses in
  // `verifyAnchorCheckpoint` must hold — exact height, exact app_hash, matching next_validators_hash,
  // >=2 independently operated counterparty providers agreeing byte-for-byte, inside the client's
  // trusting period, client not frozen. Anything short of that throws; nothing downgrades silently.
  //
  // What it is NOT: freshness is still unattested, and nothing says the oracle price is correct. It
  // moves the forgery cost from "operate a web server" to ">1/3 of dYdX staked power, slashably, on
  // chain". Trust priced in stake, not zero trust.
  CHECKPOINTED: 'ics23-verified-against-a-signed-app_hash-anchored-to-a-trusted-checkpoint',
};

/**
 * Pin one height and obtain the app_hash for it from several independent providers.
 * Every proof in an attestation roots into THIS app_hash, so one anchor covers a whole batch.
 *
 * `height` pins a PAST block instead of tracking the tip. That is what a realized funding tick needs
 * — the samples for an hour exist only at `effectiveAtHeight - 1`, before the tick clears them — and
 * it changes nothing about the checks: the same header hash, validator-set hash, 2/3 signature and
 * cross-provider corroboration all run against the pinned height. Pass DYDX_ARCHIVE_RPCS with it;
 * the default list contains a pruning node that will simply drop out of the corroborator count.
 *
 * `checkpoint` closes the circularity described in the header of this file. Pass `true` (or an options
 * object for `readCheckpointFor`) and the anchor is instead pinned to a height that ANOTHER chain's
 * validators have independently committed to, verified against that chain's own ICS-23 proof, and
 * `trust` becomes TRUST.CHECKPOINTED. It CHOOSES the height — `consensus_state(H).root` is
 * `header[H].app_hash`, so the anchor must sit at H-1 — and passing an incompatible `height` alongside
 * it is an error rather than a silent override. If the checkpoint cannot be obtained, corroborated,
 * or matched, this THROWS: a caller that asked for a checkpoint and quietly received a merely-signed
 * anchor is exactly the failure mode the checkpoint exists to remove.
 */
export async function openAnchor({ rpcs = DYDX_RPCS, timeoutMs = 15000, checkValidatorSet = true, height: pinnedHeight = null, checkpoint = null } = {}) {
  const t0 = Date.now();
  if (pinnedHeight !== null && !(Number.isInteger(pinnedHeight) && pinnedHeight > 0)) {
    throw new Error(`dydx-attest: pinned height must be a positive integer, got ${pinnedHeight}`);
  }
  // Dynamic import: ibc-checkpoint.js consumes this module's CometBFT helpers, so a static import here
  // would close a cycle. Loading it lazily keeps the dependency one-directional at module scope.
  let ibc = null, checkpointRead = null;
  if (checkpoint) {
    ibc = await import('./ibc-checkpoint.js');
    checkpointRead = await ibc.readCheckpointFor(checkpoint === true ? {} : checkpoint);
    const want = ibc.anchorHeightFor(checkpointRead);
    if (pinnedHeight !== null && pinnedHeight !== want) {
      throw new Error(`dydx-attest: a checkpoint pins the anchor to height ${want} (checkpointed dYdX height ${checkpointRead.dydxHeight}), but height ${pinnedHeight} was also requested — refusing to silently override either`);
    }
    pinnedHeight = want;
  }
  const statuses = await Promise.allSettled(rpcs.map((r) => jrpc(r, 'status', {}, timeoutMs).then((s) => ({ rpc: r, s }))));
  const live = statuses.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (live.length < MIN_CORROBORATORS) {
    throw new Error(`dydx-attest: only ${live.length} of ${rpcs.length} RPCs answered; need ${MIN_CORROBORATORS} independent providers to corroborate a root`);
  }
  for (const { rpc, s } of live) {
    if (s.node_info.network !== DYDX_CHAIN_ID) throw new Error(`dydx-attest: ${rpc} reports chain ${s.node_info.network}, expected ${DYDX_CHAIN_ID}`);
  }
  const tipHeight = Math.min(...live.map(({ s }) => Number(s.sync_info.latest_block_height))) - PROOF_LAG;
  if (pinnedHeight !== null && pinnedHeight > tipHeight + PROOF_LAG) {
    throw new Error(`dydx-attest: pinned height ${pinnedHeight} is ahead of the chain tip ${tipHeight + PROOF_LAG}`);
  }
  const height = pinnedHeight ?? tipHeight;

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

  const anchor = {
    chainId: header.chain_id,
    height,                                 // the height the proofs are taken at
    pinned: pinnedHeight !== null,          // false = tracking the tip, true = a chosen past block
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
    checkpoint: null,
    // Which dYdX operators can actually serve an ICS-23 STATE proof at this height. `corroborators`
    // above counts providers that served a HEADER, and those are different windows on the same node:
    // measured, every dYdX endpoint serves `commit` two days deep while only one serves state there.
    // Filled in only on the checkpointed path, where the anchor deliberately moves off the tip.
    proofDepth: null,
    _header: header,
    _commit: commit,
    _validators: validatorSet,
    ms: Date.now() - t0,
  };

  // TRUST.CHECKPOINTED is set HERE and nowhere else. Every clause is in verifyAnchorCheckpoint, and
  // it throws rather than returning a weaker label.
  if (checkpointRead) {
    anchor.checkpoint = ibc.verifyAnchorCheckpoint(anchor, checkpointRead);
    anchor.trust = TRUST.CHECKPOINTED;
    anchor.proofDepth = await ibc.probeProofDepth({ height: anchor.height, timeoutMs });

    // A checkpointed anchor is ALWAYS off the tip — the counterparty's newest stored height is minutes
    // to hours behind — and `proveKey` defaults to `primary`, which is whichever provider answered
    // `status` first. Measured: publichode prunes application state to ~100 blocks while still serving
    // headers millions deep, so leaving `primary` alone turns every checkpointed attestation into
    // `code 7 proof is unexpectedly empty` on a node that is behaving perfectly normally. Reorder to
    // the providers that were just MEASURED to serve a state proof at this exact height.
    //
    // This does not weaken anything: `proveKey` still requires the proof to root into the anchored
    // app_hash, which is now the checkpointed one. A provider here is a byte carrier, not an authority
    // — and that is precisely what a checkpoint buys, because the root no longer comes from whoever
    // hands over the bytes.
    const proving = new Set(anchor.proofDepth.endpoints.filter((e) => e.served).map((e) => e.url));
    const ordered = [...anchor.providers].sort((a, b) => (proving.has(b) ? 1 : 0) - (proving.has(a) ? 1 : 0));
    if (!proving.has(ordered[0])) {
      throw new Error(`dydx-attest: checkpointed at height ${anchor.height}, but none of the corroborating providers (${anchor.providers.join(', ')}) can serve an ICS-23 state proof there — ${anchor.proofDepth.endpoints.map((e) => `${e.operator}:${e.served ? 'ok' : e.detail}`).join('; ')}. The checkpoint is valid and the state is unreachable; refusing rather than reporting a proof failure as a chain disagreement.`);
    }
    anchor.providers = ordered;
    anchor.primary = ordered[0];
    anchor.ms = Date.now() - t0;
  }
  return anchor;
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
  return { value, storeRoot: storeRoot.toString('hex').toUpperCase(), bytes, depth, rpc: endpoint };
}

/**
 * `proveKey` against every corroborating provider in turn, returning the first that answers.
 *
 * THIS DOES NOT WEAKEN THE CLAIM, and the reason is the app_hash comparison inside `proveKey`:
 * whoever serves the bytes, the proof must still hash to the anchor's signature-verified app_hash. A
 * provider here is a byte carrier, not an authority, and a lying one is caught by the same check that
 * catches an honest one serving the wrong height. What it buys is liveness. Measured 2026-07-28: at a
 * height one hour back, publicnode answers `proof is unexpectedly empty; ensure height has not been
 * pruned` while kingnodes and polkachu both serve it, and even at the tip publicnode's state window
 * is short enough that a lagging peer in the corroboration set can push the anchored height outside
 * it. Pinning one provider turns a routine pruning window into a false refusal.
 */
export async function proveKeyAny(anchor, store, key, { timeoutMs = 15000 } = {}) {
  const rpcs = anchor.providers?.length ? anchor.providers : [anchor.primary];
  let firstErr = null;
  for (const rpc of rpcs) {
    try { return await proveKey(anchor, store, key, { timeoutMs, rpc }); }
    catch (e) { firstErr ??= e; }
  }
  throw firstErr ?? new Error(`dydx-attest: no provider served ${store}/${Buffer.from(key).toString('latin1')}`);
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

// ================================================================================================
// FUNDING — the rate is not stored, and does not need to be
// ================================================================================================
//
// dYdX never commits a funding rate to a key. It commits every INPUT to one, and the aggregation
// over those inputs is deterministic integer arithmetic with no floats and no external data. So the
// rate is recomputable from state that carries an ICS-23 existence proof, which is a strictly
// stronger position than a stored rate would be: there is nothing to trust an operator about.
//
// THE ONE WIRE TYPE THAT MADE THIS LOOK IMPOSSIBLE. `MarketPremiums.premiums` is declared
// `repeated sint32`, i.e. ZIGZAG encoded. Read as a plain int32 varint every sample comes back as
// roughly -2x its true value, and the recomputed rate lands at +737 where the venue published -369.
// A constant factor of two with a flipped sign is the fingerprint. `decodePremiumStore` below is the
// only place that decision is made, and `zigzag` is applied to every element.
//
// WHAT IS TRANSCRIBED, AND FROM WHERE. `x/perpetuals/keeper/perpetual.go`,
// `MaybeProcessNewFundingTickEpoch`:
//
//     premiumPpm = AvgInt32( pad0( PremSamples[perp], max(NumPremiums, tickDur/sampleDur) ) )
//     fundingPpm = clamp( premiumPpm + DefaultFundingPpm,
//                         +/- FundingRateClampFactorPpm/1e6 * (InitialMarginPpm - MaintenanceMarginPpm) )
//
// `RemovedTailSampleRatioPpm` is 0 on mainnet, so the documented tail-trimming is a no-op and the
// combine is a plain average. `AvgInt32` is Go integer division, which truncates TOWARD ZERO — the
// same direction BigInt division truncates in JS, and NOT the same direction as Math.floor for a
// negative sum. Funding is negative about as often as positive, so using Math.floor here would be
// wrong on half the rows and right on the other half, which is the shape of bug that survives a
// casual check. Every division below is BigInt.
//
// THE TERM THAT IS EASY TO DROP. `DefaultFundingPpm` is per-perpetual and lives in the Perpetual
// object. Measured 2026-07-28 across all 296 dYdX markets: 114 have it at 0 and 182 have it at 100,
// and those 182 are exactly the markets whose published rate sits at 1.25e-5 with no premium samples
// at all. A formula that omits the term reproduces 102 of 296 markets — every one of them a market
// where both terms are zero. See T2_DYDX_FUNDING_WIRED.md; this corrects PHASE_D_FUNDING.md.

/**
 * dydxprotocol.perpetuals.PremiumStore {
 *   repeated MarketPremiums all_market_premiums = 1;
 *   uint32 num_premiums = 2;
 * }
 * dydxprotocol.perpetuals.MarketPremiums { uint32 perpetual_id = 1; repeated sint32 premiums = 2; }
 *
 * One key holds every market's samples, so a single proof covers the whole book and no market's
 * entry can be removed without breaking that proof. A market with no entry has genuinely contributed
 * no premium this epoch; the chain's own rule pads it with zeros, and so does this.
 */
export function decodePremiumStore(buf) {
  const fs = pbFields(buf);
  const markets = [];
  for (const f of fs) {
    if (f.field !== 1) continue;
    if (f.wire !== 2) throw new Error(`dydx-attest: PremiumStore.all_market_premiums has wire type ${f.wire}`);
    const g = pbFields(f.bytes);
    const premiums = [];
    for (const h of g) {
      if (h.field !== 2) continue;
      // sint32 -> zigzag, ALWAYS. Both encodings occur: proto3 packs repeated scalars by default
      // (wire 2), but a single-element field can arrive unpacked (wire 0) and both must decode alike.
      if (h.wire === 2) for (const u of uvarints(h.bytes)) premiums.push(Number(zigzag(u)));
      else if (h.wire === 0) premiums.push(Number(zigzag(h.varint)));
      else throw new Error(`dydx-attest: MarketPremiums.premiums has wire type ${h.wire}`);
    }
    // perpetual_id 0 (BTC) is a proto3 default and is therefore ABSENT from the wire, not zero-valued.
    const idField = pbFirst(g, 1);
    if (idField && idField.wire !== 0) throw new Error('dydx-attest: MarketPremiums.perpetual_id is not a varint');
    markets.push({ perpetualId: Number(idField?.varint ?? 0n), premiums });
  }
  const nf = pbFirst(fs, 2);
  if (nf && nf.wire !== 0) throw new Error('dydx-attest: PremiumStore.num_premiums is not a varint');
  return { markets, numPremiums: Number(nf?.varint ?? 0n) };
}

/** dydxprotocol.perpetuals.Params { funding_rate_clamp_factor_ppm=1; premium_vote_clamp_factor_ppm=2; min_num_votes_per_sample=3 } */
export function decodePerpetualsParams(buf) {
  const fs = pbFields(buf);
  const clamp = Number(pbFirst(fs, 1)?.varint ?? 0n);
  if (!(clamp > 0)) throw new Error('dydx-attest: perpetuals Params has no funding_rate_clamp_factor_ppm — refusing rather than assuming a default');
  return {
    fundingRateClampFactorPpm: clamp,
    premiumVoteClampFactorPpm: Number(pbFirst(fs, 2)?.varint ?? 0n),
    minNumVotesPerSample: Number(pbFirst(fs, 3)?.varint ?? 0n),
  };
}

/**
 * dydxprotocol.epochs.EpochInfo {
 *   name=1; next_tick=2; duration=3; current_epoch=4; current_epoch_start_block=5;
 *   is_initialized=6; fast_forward_next_tick=7
 * }
 * The tick and sample durations are read from state rather than hardcoded as 3600 and 60, because a
 * governance change to either silently changes the padding target and therefore every rate.
 */
export function decodeEpochInfo(buf) {
  const fs = pbFields(buf);
  const name = pbFirst(fs, 1)?.bytes?.toString('utf8') ?? null;
  const duration = Number(pbFirst(fs, 3)?.varint ?? 0n);
  if (!name) throw new Error('dydx-attest: EpochInfo has no name');
  if (!(duration > 0)) throw new Error(`dydx-attest: epoch "${name}" has no positive duration`);
  return {
    name,
    nextTick: Number(pbFirst(fs, 2)?.varint ?? 0n),
    duration,
    currentEpoch: Number(pbFirst(fs, 4)?.varint ?? 0n),
    currentEpochStartBlock: Number(pbFirst(fs, 5)?.varint ?? 0n),
    isInitialized: Number(pbFirst(fs, 6)?.varint ?? 0n) === 1,
  };
}

/**
 * The tick rule, pure. Every argument is required and validated; there are no defaults, because a
 * default here is an invented input and the whole claim is that no input is invented.
 *
 * Returns ppm on dYdX's 8-hour convention. Divide by FUNDING_PPM_PER_HOURLY for the hourly rate.
 */
export function fundingTickPpm({
  premiums, numPremiums, defaultFundingPpm,
  initialMarginPpm, maintenanceFractionPpm, fundingRateClampFactorPpm,
  tickDurationSec, sampleDurationSec,
}) {
  const req = { numPremiums, defaultFundingPpm, initialMarginPpm, maintenanceFractionPpm, fundingRateClampFactorPpm, tickDurationSec, sampleDurationSec };
  for (const [k, v] of Object.entries(req)) {
    if (!Number.isInteger(v)) throw new Error(`dydx-attest: fundingTickPpm needs an integer ${k}, got ${v}`);
  }
  if (!Array.isArray(premiums) || premiums.some((p) => !Number.isInteger(p))) throw new Error('dydx-attest: premiums must be an array of integers');
  if (!(tickDurationSec > 0) || !(sampleDurationSec > 0)) throw new Error('dydx-attest: epoch durations must be positive');
  if (!(initialMarginPpm > 0) || !(maintenanceFractionPpm > 0) || !(fundingRateClampFactorPpm > 0)) {
    throw new Error('dydx-attest: margin and clamp parameters must be positive');
  }
  if (numPremiums < 0) throw new Error('dydx-attest: num_premiums is negative');

  const minRequired = Math.ceil(tickDurationSec / sampleDurationSec);
  const paddedTo = Math.max(numPremiums, minRequired);
  if (premiums.length > paddedTo) {
    throw new Error(`dydx-attest: ${premiums.length} premium samples exceed the padding target ${paddedTo} — the store is inconsistent, refusing`);
  }
  // pad0 then AvgInt32. The zeros contribute nothing to the sum, so padding IS the divisor.
  let sum = 0n;
  for (const p of premiums) sum += BigInt(p);
  const premiumPpm = Number(sum / BigInt(paddedTo));   // Go integer division: truncates toward zero

  const maintenanceMarginPpm = Number((BigInt(initialMarginPpm) * BigInt(maintenanceFractionPpm)) / 1000000n);
  const clampBound = Number((BigInt(fundingRateClampFactorPpm) * BigInt(initialMarginPpm - maintenanceMarginPpm)) / 1000000n);
  if (clampBound < 0) throw new Error('dydx-attest: negative funding clamp bound — maintenance margin exceeds initial margin');

  const rawPpm = premiumPpm + defaultFundingPpm;
  const ppm = Math.max(-clampBound, Math.min(clampBound, rawPpm));
  return { premiumPpm, rawPpm, clampBound, ppm, clamped: ppm !== rawPpm, paddedTo, minRequired, sampleCount: premiums.length, sumPpm: Number(sum) };
}

/**
 * The running prediction over the PARTIAL epoch — the number the indexer publishes as
 * `nextFundingRate`, which is the only funding number `dydx.js` returns and perp-gate consumes.
 *
 * Two differences from the tick rule, both measured rather than assumed:
 *   * the divisor is `num_premiums`, NOT the padded `max(num_premiums, tickDur/sampleDur)`. Mid-epoch
 *     num_premiums is well under 60, and using the padded target reproduces nothing.
 *   * the division is FLOAT, not integer. The indexer's own output is non-integer ppm
 *     (BTC 304.55263157894736 ppm at one snapshot), which is what settles it.
 * The `+ defaultFundingPpm` term is shared with the tick rule and is not optional; see the header.
 */
export function nextFundingPpm({ premiums, numPremiums, defaultFundingPpm }) {
  if (!Array.isArray(premiums) || premiums.some((p) => !Number.isInteger(p))) throw new Error('dydx-attest: premiums must be an array of integers');
  if (!Number.isInteger(numPremiums) || numPremiums < 0) throw new Error(`dydx-attest: num_premiums must be a non-negative integer, got ${numPremiums}`);
  if (!Number.isInteger(defaultFundingPpm)) throw new Error(`dydx-attest: default_funding_ppm must be an integer, got ${defaultFundingPpm}`);
  if (premiums.length && numPremiums === 0) {
    throw new Error('dydx-attest: premium samples exist but num_premiums is 0 — inconsistent store, refusing rather than dividing by zero');
  }
  let sum = 0;
  for (const p of premiums) sum += p;
  return { sumPpm: sum, sampleCount: premiums.length, ppm: numPremiums > 0 ? sum / numPremiums + defaultFundingPpm : defaultFundingPpm };
}

/**
 * Prove the four MARKET-INDEPENDENT funding inputs once per anchor: the premium store, the module
 * params, and both epoch infos. Every one must verify; a missing key is a refusal, never a default.
 *
 * The result carries the anchor's app_hash so it cannot be silently reused against another anchor —
 * mixing inputs proven at two heights is exactly the forgery `proveKey`'s root check exists to stop,
 * and it would slip past that check if the mixing happened at this layer instead.
 */
export async function proveFundingContext(anchor, { timeoutMs = 15000 } = {}) {
  const [ps, pr, te, se] = await Promise.all([
    proveKeyAny(anchor, STORES.premiumSamples, KEYS.premiumSamples(), { timeoutMs }),
    proveKeyAny(anchor, STORES.perpetualsParams, KEYS.perpetualsParams(), { timeoutMs }),
    proveKeyAny(anchor, STORES.epochs, KEYS.epochInfo(EPOCH_FUNDING_TICK), { timeoutMs }),
    proveKeyAny(anchor, STORES.epochs, KEYS.epochInfo(EPOCH_FUNDING_SAMPLE), { timeoutMs }),
  ]);
  const premiumStore = decodePremiumStore(ps.value);
  const params = decodePerpetualsParams(pr.value);
  const tickEpoch = decodeEpochInfo(te.value);
  const sampleEpoch = decodeEpochInfo(se.value);
  if (tickEpoch.name !== EPOCH_FUNDING_TICK) throw new Error(`dydx-attest: epochs/Info:${EPOCH_FUNDING_TICK} decodes to name "${tickEpoch.name}"`);
  if (sampleEpoch.name !== EPOCH_FUNDING_SAMPLE) throw new Error(`dydx-attest: epochs/Info:${EPOCH_FUNDING_SAMPLE} decodes to name "${sampleEpoch.name}"`);
  return {
    premiumStore, params, tickEpoch, sampleEpoch,
    height: anchor.height, appHash: anchor.appHash,
    proofBytes: ps.bytes + pr.bytes + te.bytes + se.bytes,
    valueBytes: ps.value.length + pr.value.length + te.value.length + se.value.length,
    proofs: { premSamples: ps.bytes, params: pr.bytes, tickEpoch: te.bytes, sampleEpoch: se.bytes },
  };
}

/**
 * Recompute both funding rates for one market from proven state, and REFUSE if anything is missing.
 *
 * `perp` and `tier` may be supplied by a caller that has already proven them (proveMarket does), in
 * which case no extra queries are made; otherwise they are proven here. The ticker cross-check is
 * repeated even when the Perpetual is handed in, because attesting one market's funding against
 * another market's premiums is the failure this whole path has to make impossible.
 */
export async function proveFunding(anchor, { ticker, perpetualId, fundingCtx, perp, tier, timeoutMs = 15000 }) {
  const want = normTicker(ticker);
  const ctx = fundingCtx ?? await proveFundingContext(anchor, { timeoutMs });
  if (ctx.appHash !== anchor.appHash) {
    throw new Error(`dydx-attest: funding inputs were proven under app_hash ${ctx.appHash} but the anchor is ${anchor.appHash} — refusing to mix heights`);
  }
  let extraBytes = 0;
  let p = perp;
  if (!p) {
    const pp = await proveKeyAny(anchor, STORES.perpetual, KEYS.perpetual(perpetualId), { timeoutMs });
    p = decodePerpetual(pp.value); extraBytes += pp.bytes;
  }
  if (normTicker(p.ticker) !== want) {
    throw new Error(`dydx-attest: Perp:${perpetualId} is ticker "${p.ticker}" on chain, not "${want}" — refusing to attest funding for the wrong market`);
  }
  let t = tier;
  if (!t) {
    const tp = await proveKeyAny(anchor, STORES.liqTier, KEYS.liqTier(p.liquidityTier), { timeoutMs });
    t = decodeLiquidityTier(tp.value); extraBytes += tp.bytes;
  }

  const entry = ctx.premiumStore.markets.find((m) => m.perpetualId === p.id);
  const premiums = entry ? entry.premiums : [];

  const tick = fundingTickPpm({
    premiums,
    numPremiums: ctx.premiumStore.numPremiums,
    defaultFundingPpm: p.defaultFundingPpm,
    initialMarginPpm: t.initialMarginPpm,
    maintenanceFractionPpm: t.maintenanceFractionPpm,
    fundingRateClampFactorPpm: ctx.params.fundingRateClampFactorPpm,
    tickDurationSec: ctx.tickEpoch.duration,
    sampleDurationSec: ctx.sampleEpoch.duration,
  });
  const next = nextFundingPpm({ premiums, numPremiums: ctx.premiumStore.numPremiums, defaultFundingPpm: p.defaultFundingPpm });

  // Is the tick rule's output a SETTLED rate or a hypothetical? It is settled exactly when the epoch
  // is complete — one sample round per sample-epoch for the whole tick epoch — which is a fact read
  // out of proven state, not a guess about where the anchor is. Mid-epoch the same arithmetic returns
  // the rate the hour WOULD settle at if the tick fired now, which the venue has never published and
  // nothing can check, so `proveMarket` withholds it from the attestable surface rather than offering
  // a number that looks comparable to a published one and is not.
  const expectedRounds = ctx.tickEpoch.duration / ctx.sampleEpoch.duration;
  const tickEpochComplete = Number.isInteger(expectedRounds) && ctx.premiumStore.numPremiums === expectedRounds;

  return {
    ticker: p.ticker,
    perpetualId: p.id,
    fundingHourly: next.ppm / FUNDING_PPM_PER_HOURLY,
    fundingTickHourly: tick.ppm / FUNDING_PPM_PER_HOURLY,
    tickEpochComplete,
    ppm: { next: next.ppm, tick: tick.ppm, premium: tick.premiumPpm, raw: tick.rawPpm, defaultFunding: p.defaultFundingPpm, clampBound: tick.clampBound },
    clamped: tick.clamped,
    // `sampled:false` means this market contributed no premium this epoch, which is a real state and
    // not a missing input: the PremiumStore value is proven in full, so an absent entry is committed.
    sampled: !!entry,
    sampleCount: premiums.length,
    numPremiums: ctx.premiumStore.numPremiums,
    paddedTo: tick.paddedTo,
    premiums,
    epoch: {
      tickDurationSec: ctx.tickEpoch.duration,
      sampleDurationSec: ctx.sampleEpoch.duration,
      currentTickEpoch: ctx.tickEpoch.currentEpoch,
      tickEpochStartBlock: ctx.tickEpoch.currentEpochStartBlock,
      sampleEpochStartBlock: ctx.sampleEpoch.currentEpochStartBlock,
    },
    proofBytes: ctx.proofBytes + extraBytes,
    trust: anchor.trust,
    height: anchor.height,
    appHash: anchor.appHash,
  };
}

// ---------------------------------------------------------------- indexer side

/** The funding ticks the venue itself published, each with the exact block height it executed at. */
export async function fetchHistoricalFunding(ticker, { limit = 5, timeoutMs = 15000 } = {}) {
  const res = await fetch(`${DYDX_HISTORICAL_FUNDING}/${normTicker(ticker)}?limit=${limit}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`dydx indexer historicalFunding ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j?.historicalFunding)) throw new Error('dydx-attest: unexpected historicalFunding shape');
  return j.historicalFunding;
}

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
 *
 * `fundingCtx` is opt-in and adds the two funding rates to `proven`. It is opt-in because the four
 * funding inputs are market-INDEPENDENT: proving them once per anchor and passing the result in costs
 * four queries for a whole batch, while folding them into this function would cost four per market.
 */
export async function proveMarket(anchor, { ticker, perpetualId, fundingCtx = null, timeoutMs = 15000 }) {
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
  const proven = {
    oraclePrice: price.price,
    maintenanceMarginRate: tier.maintenanceMarginRate,
    initialMarginRate: tier.initialMarginRate,
    maxLeverage: tier.maxLeverage,
  };
  let funding = null;
  if (fundingCtx) {
    funding = await proveFunding(anchor, { ticker, perpetualId, fundingCtx, perp, tier, timeoutMs });
    proven.fundingHourly = funding.fundingHourly;
    // Withheld unless the epoch is complete: see proveFunding. An incomplete epoch's tick output is a
    // hypothetical, and offering it here would let a caller compare it to a published realized rate
    // and get a verdict that means nothing. `attest` then refuses it with NOT_IN_PROOF.
    if (funding.tickEpochComplete) proven.fundingTickHourly = funding.fundingTickHourly;
  }
  return {
    ticker: perp.ticker,
    perp,
    tier,
    funding,
    proven,
    proofBytes: perpProof.bytes + priceProof.bytes + tierProof.bytes + (funding ? funding.proofBytes : 0),
    proofs: { perp: perpProof.bytes, price: priceProof.bytes, tier: tierProof.bytes, funding: funding ? funding.proofBytes : 0 },
  };
}

/**
 * The top-level check: does a value the indexer handed us agree with the chain's own state?
 *
 * Returns a verdict object and never throws for data reasons. `ok:false` with a `reason` is a REFUSAL
 * and must be treated as one — there is deliberately no "probably fine" branch.
 */
export async function attest({ ticker, perpetualId, quantity, claimed, bound, anchor, market, fundingCtx = null, timeoutMs = 15000 }) {
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
    if (!m) m = await proveMarket(anchor, { ticker, perpetualId, fundingCtx, timeoutMs });
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
 * ATTESTED or REFUSED with a reason.
 *
 * `fundingHourly` used to be an unconditional refusal here. It is now recomputed from proven state
 * like the rest, which is the point of the change — but only when a `fundingCtx` is supplied, because
 * fabricating one silently would cost four extra proofs per market and hide that cost. Without one
 * the field refuses with NOT_IN_PROOF, which is a refusal that names its own cause rather than
 * pretending funding is unprovable.
 */
export async function attestContext({ symbol, context, anchor, bounds, perpetualId, fundingCtx = null, timeoutMs = 15000 }) {
  const ticker = normTicker(symbol);
  const fields = { markPx: 'oraclePrice', maintMarginRate: 'maintenanceMarginRate', maxLeverage: 'maxLeverage', fundingHourly: 'fundingHourly' };
  let market = null, marketError = null;
  try { market = await proveMarket(anchor, { ticker, perpetualId, fundingCtx, timeoutMs }); } catch (e) { marketError = e.message; }

  const out = {};
  for (const [ctxKey, quantity] of Object.entries(fields)) {
    const claimed = context?.[ctxKey];
    if (marketError && !NOT_ATTESTABLE[quantity]) {
      out[ctxKey] = { quantity, ok: false, status: 'REFUSED', reason: 'PROOF_FAILED', detail: marketError, claimed };
      continue;
    }
    out[ctxKey] = await attest({ ticker, perpetualId, quantity, claimed, bound: bounds?.[quantity], anchor, market, fundingCtx, timeoutMs });
  }
  const attested = Object.values(out).filter((v) => v.ok).length;
  return { ticker, fields: out, attested, total: Object.keys(fields).length, trust: anchor.trust, chain: { height: anchor.height, appHash: anchor.appHash, corroborators: anchor.corroborators } };
}
