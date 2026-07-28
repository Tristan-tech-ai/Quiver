// IBC WEAK-SUBJECTIVITY CHECKPOINT — read a dYdX app_hash out of ANOTHER chain's committed state.
//
// ============================================================================================
// WHY THIS FILE EXISTS
// ============================================================================================
// `dydx-attest.js` verifies an ICS-23 proof against an app_hash it got from dYdX RPCs, whose validator
// set it also got from dYdX RPCs, checked against a validators_hash in a header those same RPCs served.
// Internally consistent, and circular: a malicious provider can invent a validator set of its own keys,
// sign a fabricated block with them, and every check passes. The module's own header says so.
//
// The way out is a value committed by a DIFFERENT validator set. Five Cosmos chains run a live IBC
// 07-tendermint light client of dydx-mainnet-1, and an IBC consensus state's `root` IS the dYdX
// `app_hash` — not a proxy for it, not the validator set that signs it, the exact 32 bytes every
// ICS-23 proof in dydx-attest.js roots into:
//
//     ibc consensus_state(H).root.hash == dydx header[H].app_hash
//
// So a checkpoint does not have to reason about validator sets at all. It pins the anchor directly.
// That value is read out of the counterparty's own IAVL store with `abci_query prove=true` and verified
// with the SAME `verifyStoreProof` used for dYdX — the counterparty is proving to us, not telling us.
//
// ============================================================================================
// WHAT THIS BUYS, STATED EXACTLY. Do not let it be quoted as "trustless".
// ============================================================================================
// BEFORE: to forge an attestation an attacker needs one malicious web server.
// AFTER:  the app_hash must ALSO equal a value inside Osmosis's state tree, proven by ICS-23 against an
//         Osmosis app_hash that Osmosis's own validators signed. Getting a forged value into that slot
//         means submitting a dYdX header that passes Osmosis's 07-tendermint client — which needs
//         signatures from more than 1/3 of the dYdX validator set by stake, slashably, permanently on
//         chain.
//
// The attack moves from "operate a web server" to "control >1/3 of dYdX staked power and get caught".
// That is trust priced in slashable stake, not zero trust. The recursion is real and does not vanish:
// we have no independent checkpoint for Osmosis either. What makes it not a shell game is that an
// attacker must now corrupt two disjoint validator sets and two disjoint RPC operator sets at once, and
// that the client has been continuously updated with real value flowing over the channel since
// 2025-11-14 (measured oldest stored state) — a client fed a fabricated dYdX would have diverged long
// ago and broken live transfers. Recursion bottoms out at "some real validator set with real stake".
//
// STILL NOT FIXED BY ANY OF THIS: freshness is not attested (providers may withhold or delay, and a
// checkpoint is by construction a PAST height); and nothing here says dYdX's oracle price is correct,
// only that the chain committed to it. Attestation is provenance, never truth.
//
// ============================================================================================
// TWO MEASUREMENT TRAPS, RECORDED SO THEY ARE NOT REDISCOVERED
// ============================================================================================
//   * Cosmos REST serves `root.hash` as BASE64 but `next_validators_hash` as HEX (it is
//     cmtbytes.HexBytes, which marshals to hex in JSON). Base64-decoding a 64-char hex string yields
//     48 bytes of garbage that reads as a real cross-chain mismatch on all five chains at once. This
//     module never parses REST for a load-bearing value — everything load-bearing comes out of a
//     proven protobuf — but any comparison script written against the LCD hits this immediately.
//   * `clients/<id>/clientState` is ITSELF a proven read, so the checkpoint HEIGHT needs no trusted
//     discovery. An earlier recipe took the height from an LCD; that put a trusted HTTP endpoint back
//     in the middle of a design whose entire purpose is removing one. It is not needed.
//
// Nothing here is served, deployed, or on chain. It lives outside src/engine/.
import { verifyStoreProof, pbFields, pbFirst } from './ics23.js';
import { headerHash, validatorSetHash, verifyCommitSignatures, TRUST } from './dydx-attest.js';

// ---------------------------------------------------------------- the counterparty chains
//
// Enumerated from dYdX's own connection list and verified from each counterparty by listing that
// chain's client_states and filtering chain_id == dydx-mainnet-1. Cosmos Hub and Celestia hold NO dYdX
// client (measured: 1,500 and 175 clients respectively, zero matching) — do not go looking.
//
// `operators` is what corroboration actually counts. Two endpoints run by one company are one witness,
// and counting them as two is the exact overclaim this module exists to avoid.
export const CHECKPOINT_CHAINS = {
  osmosis: {
    chainId: 'osmosis-1', clientId: '07-tendermint-3009', lcd: 'https://lcd.osmosis.zone',
    rpcs: [
      { url: 'https://rpc.osmosis.zone', operator: 'osmosis-foundation' },
      { url: 'https://osmosis-rpc.polkachu.com', operator: 'polkachu' },
      { url: 'https://osmosis-rpc.publicnode.com', operator: 'publicnode' },
    ],
    // Measured 2026-07-28: 15,059 stored consensus states, oldest 2025-11-14 => 255.9 days of history.
    // Deepest retention of the five, but the burstiest relayer (p50 255 s, max gap 18.6 h).
    retentionDays: 255.9,
  },
  injective: {
    chainId: 'injective-1', clientId: '07-tendermint-256', lcd: 'https://injective-api.polkachu.com',
    rpcs: [
      { url: 'https://injective-rpc.polkachu.com', operator: 'polkachu' },
      { url: 'https://injective-rpc.publicnode.com', operator: 'publicnode' },
    ],
    retentionDays: 38.6, // 927 states; metronomic hourly relayer (p50 3,600 s, max 1.4 h)
  },
  neutron: {
    chainId: 'neutron-1', clientId: '07-tendermint-72', lcd: 'https://neutron-api.polkachu.com',
    rpcs: [
      { url: 'https://neutron-rpc.polkachu.com', operator: 'polkachu' },
      { url: 'https://neutron-rpc.publicnode.com', operator: 'publicnode' },
    ],
    retentionDays: 42.0, // 3,135 states; p50 2,606 s, max 3.0 h
  },
  // Noble is the FRESHEST source measured (p50 313 s, newest state 16 s old) and it is still not the
  // default, because only one operator serves it. Reading a checkpoint through a single provider
  // reintroduces precisely the single-provider dependency this module exists to remove. Usable as a
  // freshness supplement next to a corroborated chain; never on its own.
  noble: {
    chainId: 'noble-1', clientId: '07-tendermint-59', lcd: 'https://noble-api.polkachu.com',
    rpcs: [{ url: 'https://noble-rpc.polkachu.com', operator: 'polkachu' }],
    retentionDays: 118.2, singleOperator: true,
  },
  stride: {
    chainId: 'stride-1', clientId: '07-tendermint-133', lcd: 'https://stride-api.polkachu.com',
    rpcs: [{ url: 'https://stride-rpc.polkachu.com', operator: 'polkachu' }],
    retentionDays: 26.8, singleOperator: true,
  },
};

/** Order tried by default: most independent operators first, freshness second. */
export const PREFERRED_CHAINS = ['osmosis', 'neutron', 'injective'];

/**
 * OPERATOR OVERLAP — measured, and it is the sharpest limit on what a checkpoint chain is worth.
 *
 * The dYdX side is served by publicnode, kingnodes and polkachu. Of the five counterparty chains:
 *
 *   osmosis    osmosis-foundation, polkachu, publicnode   -> 1 operator DISJOINT from the dYdX set
 *   neutron    polkachu, publicnode                       -> 0 disjoint: a strict subset
 *   injective  polkachu, publicnode                       -> 0 disjoint: a strict subset
 *   noble      polkachu                                   -> 0 disjoint, and only one operator at all
 *   stride     polkachu                                   -> same
 *
 * A checkpoint read through the SAME companies that serve the dYdX side is still worth a great deal —
 * the consensus state is signed by the counterparty's validator set, whose signatures are verified
 * here, so an RPC operator cannot mint one — but it adds no new *observer*. The honest reading is that
 * the extra validator set is the security gain and the extra operator is the liveness/censorship gain,
 * and only `osmosis` currently supplies both. `readBestCheckpoint` therefore prefers a chain that
 * brings a disjoint operator, and reports the overlap either way rather than letting a subset read as
 * independence.
 *
 * Caveat stated once: operator identity is inferred from hostname and ownership, not proven. Two
 * hostnames could share infrastructure without saying so, and this module would not know.
 */
export const DYDX_RPC_OPERATORS = ['publicnode', 'kingnodes', 'polkachu'];

/**
 * Same floor as dydx-attest's MIN_CORROBORATORS, and for the same reason: below two independently
 * operated providers the corroboration step is vacuous. Deliberately NOT imported, so that relaxing
 * one side cannot silently relax the other — gateD3c asserts the two are equal.
 */
export const MIN_CHECKPOINT_OPERATORS = 2;

const TM_CLIENT_STATE = '/ibc.lightclients.tendermint.v1.ClientState';
const TM_CONSENSUS_STATE = '/ibc.lightclients.tendermint.v1.ConsensusState';
/** A proof needs the header at X+1 to exist, so never query the counterparty tip. */
const COUNTERPARTY_LAG = 3;

// ---------------------------------------------------------------- rpc

async function jrpc(base, method, params, timeoutMs) {
  const res = await fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${base}: http ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${base}: ${String(j.error.data || j.error.message).slice(0, 140)}`);
  return j.result;
}

// ---------------------------------------------------------------- protobuf decoders
//
// Every field below was cross-checked against the counterparty LCD's own JSON on all five chains
// before this module was written (chain_id, trusting_period, unbonding_period, max_clock_drift,
// latest_height, root.hash, next_validators_hash: MATCH on 5/5). A decoder nobody checked against an
// independent rendering of the same bytes is a decoder that is confidently wrong.

/** google.protobuf.Any { string type_url = 1; bytes value = 2 } */
export function decodeAny(buf) {
  const f = pbFields(buf);
  return { typeUrl: pbFirst(f, 1)?.bytes?.toString('utf8') ?? null, value: pbFirst(f, 2)?.bytes ?? null };
}

/** google.protobuf.Duration { int64 seconds = 1; int32 nanos = 2 } -> seconds */
const durationSec = (b) => (b ? Number(pbFirst(pbFields(b), 1)?.varint ?? 0n) : null);
/** ibc.core.client.v1.Height { uint64 revision_number = 1; uint64 revision_height = 2 } */
const heightOf = (b) => {
  if (!b) return { revision: 0, height: 0 };
  const f = pbFields(b);
  return { revision: Number(pbFirst(f, 1)?.varint ?? 0n), height: Number(pbFirst(f, 2)?.varint ?? 0n) };
};

/** ibc.lightclients.tendermint.v1.ClientState — fields 1,3,4,5,6,7 are the ones that matter here. */
export function decodeTmClientState(buf) {
  const f = pbFields(buf);
  const frozen = heightOf(pbFirst(f, 6)?.bytes);
  return {
    chainId: pbFirst(f, 1)?.bytes?.toString('utf8') ?? null,
    trustingPeriodSec: durationSec(pbFirst(f, 3)?.bytes),
    unbondingPeriodSec: durationSec(pbFirst(f, 4)?.bytes),
    maxClockDriftSec: durationSec(pbFirst(f, 5)?.bytes),
    frozenHeight: frozen,
    // A non-zero frozen_height means a light-client MISBEHAVIOUR was proven against this client. One
    // such client exists in the wild (vota-ash). Its stored states are not a checkpoint of anything.
    frozen: frozen.height !== 0 || frozen.revision !== 0,
    latestHeight: heightOf(pbFirst(f, 7)?.bytes),
  };
}

/** ibc.lightclients.tendermint.v1.ConsensusState { Timestamp 1; MerkleRoot 2; bytes nvh 3 } */
export function decodeTmConsensusState(buf) {
  const f = pbFields(buf);
  const tsField = pbFirst(f, 1)?.bytes;
  const rootField = pbFirst(f, 2)?.bytes;
  const nvhField = pbFirst(f, 3)?.bytes;
  if (!rootField) throw new Error('ibc-checkpoint: consensus state has no MerkleRoot');
  const ts = tsField ? pbFields(tsField) : [];
  const seconds = Number(pbFirst(ts, 1)?.varint ?? 0n);
  const nanos = Number(pbFirst(ts, 2)?.varint ?? 0n);
  const root = pbFirst(pbFields(rootField), 1)?.bytes;
  if (!root || root.length !== 32) throw new Error(`ibc-checkpoint: MerkleRoot hash is ${root?.length ?? 0} bytes, expected 32`);
  if (!nvhField || nvhField.length !== 32) throw new Error(`ibc-checkpoint: next_validators_hash is ${nvhField?.length ?? 0} bytes, expected 32`);
  return {
    // The prize: this IS dydx header[H].app_hash.
    appHash: root.toString('hex').toUpperCase(),
    nextValidatorsHash: nvhField.toString('hex').toUpperCase(),
    timeSeconds: seconds,
    timeNanos: nanos,
    time: new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, `.${String(nanos).padStart(9, '0')}Z`),
  };
}

// ---------------------------------------------------------------- one proven read

/**
 * Read one key out of a counterparty chain's `ibc` store WITH a proof, and check that the proof roots
 * into an app_hash that appears in a header whose own hash equals the block ID its commit votes on.
 *
 * `verifySignatures` additionally ed25519-verifies the counterparty's precommits and requires >2/3 of
 * its voting power — reusing dydx-attest's CometBFT code unmodified, because the format is the chain's,
 * not the venue's. Without it the counterparty app_hash is merely RPC-asserted, which would make the
 * whole checkpoint an expensive way to trust a different web server.
 */
async function provenIbcRead({ rpc, chainId, key, timeoutMs, verifySignatures }) {
  const status = await jrpc(rpc.url, 'status', {}, timeoutMs);
  if (status.node_info.network !== chainId) {
    throw new Error(`${rpc.url} reports chain ${status.node_info.network}, expected ${chainId}`);
  }
  const queryHeight = Number(status.sync_info.latest_block_height) - COUNTERPARTY_LAG;
  const r = (await jrpc(rpc.url, 'abci_query', {
    path: '/store/ibc/key', data: Buffer.from(key).toString('hex'), height: String(queryHeight), prove: true,
  }, timeoutMs)).response;

  if (r.code && Number(r.code) !== 0) throw new Error(`abci_query code ${r.code} ${r.log || ''}`);
  if (!r.value) throw new Error(`no value at ibc/${key} — the key does not exist in ${chainId} state`);
  const ops = r.proofOps?.ops;
  if (!ops?.length) throw new Error(`${rpc.url} returned no proof for ibc/${key}`);

  const value = Buffer.from(r.value, 'base64');
  const { appRoot, bytes, depth } = verifyStoreProof({ ops, store: 'ibc', key, value });

  // The height the node actually answered at, which is not always the one requested.
  const at = Number(r.height);
  const c = await jrpc(rpc.url, 'commit', { height: String(at + 1) }, timeoutMs);
  const header = c.signed_header.header, commit = c.signed_header.commit;
  const computed = headerHash(header);
  if (computed !== commit.block_id.hash) {
    throw new Error(`${rpc.url}: ${chainId} header hash ${computed} != commit.block_id.hash ${commit.block_id.hash}`);
  }
  const appRootHex = appRoot.toString('hex').toUpperCase();
  if (appRootHex !== String(header.app_hash).toUpperCase()) {
    throw new Error(`${rpc.url}: proof roots to ${appRootHex} but ${chainId} app_hash at ${at + 1} is ${header.app_hash}`);
  }

  let signatures = null;
  if (verifySignatures) {
    const validators = await fetchValidators(rpc.url, at + 1, timeoutMs);
    const vsHash = validatorSetHash(validators);
    if (vsHash !== String(header.validators_hash).toUpperCase()) {
      throw new Error(`${rpc.url}: ${chainId} validator set hashes to ${vsHash}, header says ${header.validators_hash}`);
    }
    signatures = verifyCommitSignatures({ header, commit, validators });
    // Observed once on 2026-07-28: all three Osmosis providers returned 70/70 INVALID precommits within
    // the same second, at heights that verified perfectly minutes later and in 8/8 subsequent runs. The
    // cause was not established (it is not `canonical:false`, which yields FEWER signatures rather than
    // bad ones, and not a non-zero round). It is recorded here rather than smoothed over, and the
    // details below exist so the next occurrence is diagnosable instead of re-investigated from zero.
    // Note what the module did: it REFUSED. A transient that fails closed is the correct failure.
    if (signatures.failed > 0) {
      throw new Error(`${rpc.url}: ${signatures.failed}/${signatures.verified + signatures.failed} ${chainId} precommit(s) present but INVALID at ${at + 1} (round ${commit.round}, canonical ${c.canonical}, ${validators.length} validators, sample vote ts ${commit.signatures.find((x) => x.signature)?.timestamp}) — refusing`);
    }
    if (!signatures.twoThirds) throw new Error(`${rpc.url}: only ${(signatures.powerFraction * 100).toFixed(2)}% of ${chainId} voting power verified at ${at + 1}; need >66.67%`);
  }

  return {
    value, bytes, depth, queryHeight: at,
    hostAppHash: String(header.app_hash).toUpperCase(),
    hostBlockHash: computed,
    hostTime: header.time,
    signatures,
    rpc: rpc.url, operator: rpc.operator,
  };
}

/** CometBFT caps `per_page` at 100 on current versions, so a 180-validator set needs paging. */
async function fetchValidators(url, height, timeoutMs) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const v = await jrpc(url, 'validators', { height: String(height), page: String(page), per_page: '100' }, timeoutMs);
    out.push(...v.validators);
    if (out.length >= Number(v.total)) break;
  }
  return out;
}

// ---------------------------------------------------------------- the checkpoint

/**
 * Read a dYdX checkpoint from ONE counterparty chain, corroborated across its own providers.
 *
 * Returns { ok:true, ... } or throws. There is deliberately no "probably fine" branch and no path that
 * returns a checkpoint assembled from fewer than `minOperators` independent operators.
 *
 * @param chain      key of CHECKPOINT_CHAINS
 * @param dydxHeight null = whatever height the client is currently at (proven, not asked of an LCD);
 *                   a number = that exact height, which must be one the counterparty actually stored.
 * @param allowExpired  false. An expired checkpoint is REFUSED LOUDLY, never downgraded to a weaker
 *                   label behind the caller's back.
 */
export async function readCheckpoint({
  chain = 'osmosis', dydxHeight = null, timeoutMs = 25000,
  minOperators = MIN_CHECKPOINT_OPERATORS, verifySignatures = true, allowExpired = false,
  allowSingleOperator = false, rpcs = null,
} = {}) {
  const t0 = Date.now();
  const base = CHECKPOINT_CHAINS[chain];
  if (!base) throw new Error(`ibc-checkpoint: unknown chain "${chain}"; known: ${Object.keys(CHECKPOINT_CHAINS).join(', ')}`);
  // `rpcs` narrows the provider list to a subset of the chain's known endpoints. It exists so a gate
  // can hand this function ONE provider and prove that the checkpoint is refused — a corroboration
  // floor nothing ever tries to breach is a floor nobody has checked.
  const C = rpcs ? { ...base, rpcs: base.rpcs.filter((r) => rpcs.includes(r.url) || rpcs.includes(r.operator)), singleOperator: undefined } : base;
  if (rpcs && !C.rpcs.length) throw new Error(`ibc-checkpoint: none of [${rpcs.join(', ')}] is a known ${chain} endpoint`);
  if (C.singleOperator && !allowSingleOperator && minOperators > 1) {
    throw new Error(`ibc-checkpoint: ${chain} is reachable through ONE operator (${C.rpcs[0].operator}); using it alone reintroduces the single-provider dependency this module exists to remove. Prefer ${PREFERRED_CHAINS.join('/')}, or pass allowSingleOperator with eyes open.`);
  }
  if (dydxHeight !== null && !(Number.isInteger(dydxHeight) && dydxHeight > 0)) {
    throw new Error(`ibc-checkpoint: dydxHeight must be a positive integer, got ${dydxHeight}`);
  }

  // --- 1. the client state, PROVEN. Gives the height, the trusting period, and the frozen flag.
  const csKey = `clients/${C.clientId}/clientState`;
  const csReads = await Promise.allSettled(C.rpcs.map((rpc) => provenIbcRead({ rpc, chainId: C.chainId, key: csKey, timeoutMs, verifySignatures })));
  const csOk = csReads.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  const csErrors = csReads.filter((x) => x.status === 'rejected').map((x) => String(x.reason?.message ?? x.reason).slice(0, 160));
  if (!csOk.length) throw new Error(`ibc-checkpoint: no ${chain} provider served a proven client state: ${csErrors.join(' | ')}`);

  const csAny = decodeAny(csOk[0].value);
  if (csAny.typeUrl !== TM_CLIENT_STATE) throw new Error(`ibc-checkpoint: client state Any is ${csAny.typeUrl}, expected ${TM_CLIENT_STATE}`);
  const clientState = decodeTmClientState(csAny.value);
  if (clientState.chainId !== 'dydx-mainnet-1') {
    throw new Error(`ibc-checkpoint: ${chain} client ${C.clientId} tracks ${clientState.chainId}, not dydx-mainnet-1`);
  }
  if (clientState.frozen) {
    throw new Error(`ibc-checkpoint: ${chain} client ${C.clientId} is FROZEN at ${clientState.frozenHeight.revision}-${clientState.frozenHeight.height} — a light-client misbehaviour was proven against it, so its stored states checkpoint nothing`);
  }

  const revision = clientState.latestHeight.revision;
  const height = dydxHeight ?? clientState.latestHeight.height;
  const requestedHistorical = dydxHeight !== null && dydxHeight !== clientState.latestHeight.height;

  // --- 2. the consensus state at that height, PROVEN, from every provider.
  const key = `clients/${C.clientId}/consensusStates/${revision}-${height}`;
  const reads = await Promise.allSettled(C.rpcs.map((rpc) => provenIbcRead({ rpc, chainId: C.chainId, key, timeoutMs, verifySignatures })));
  const ok = reads.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  const errors = reads.filter((x) => x.status === 'rejected').map((x) => String(x.reason?.message ?? x.reason).slice(0, 160));

  if (!ok.length) {
    const why = requestedHistorical
      ? `. Height ${height} is probably not one ${chain} stored — a counterparty holds only the heights its relayer actually submitted, not every height, so an arbitrary historical height has no checkpoint`
      : '';
    throw new Error(`ibc-checkpoint: no ${chain} provider served a proven consensus state at ${revision}-${height}${why}: ${errors.join(' | ')}`);
  }

  // --- 3. corroboration, counted by OPERATOR and required to be byte-identical.
  const operators = [...new Set(ok.map((r) => r.operator))];
  const first = ok[0].value;
  const byteIdentical = ok.every((r) => r.value.equals(first));
  if (!byteIdentical) {
    throw new Error(`ibc-checkpoint: ${chain} providers returned DIFFERENT consensus-state bytes at ${revision}-${height} — ${ok.map((r) => `${r.operator}:${r.value.toString('hex').slice(0, 24)}`).join(' ')}`);
  }
  if (operators.length < minOperators) {
    throw new Error(`ibc-checkpoint: only ${operators.length} independent ${chain} operator(s) (${operators.join(', ')}) proved the checkpoint at ${revision}-${height}; need ${minOperators}. A checkpoint from one operator is one web server again. Failures: ${errors.join(' | ') || 'none'}`);
  }

  const consAny = decodeAny(first);
  if (consAny.typeUrl !== TM_CONSENSUS_STATE) throw new Error(`ibc-checkpoint: consensus state Any is ${consAny.typeUrl}, expected ${TM_CONSENSUS_STATE}`);
  const cons = decodeTmConsensusState(consAny.value);

  // --- 4. expiry. LOUD, never a silent downgrade.
  //
  // Note what the trusting period does and does not govern. It bounds light-client JUMPS: a state older
  // than it may no longer serve as the trust root for a NEW update. It is not a statement that the
  // record went bad. A state written 30 days ago is still exactly what that validator set committed to.
  // This module still refuses by default, because "expired but historically valid" is a distinction a
  // caller must make deliberately rather than inherit silently — and because an expired client is often
  // an ABANDONED one, whose last write may predate a chain halt or an upgrade nobody relayed.
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSeconds = nowSec - cons.timeSeconds;
  const expired = ageSeconds > clientState.trustingPeriodSec;
  if (expired && !allowExpired) {
    throw new Error(`ibc-checkpoint: CHECKPOINT EXPIRED — the ${chain} consensus state at ${revision}-${height} is ${(ageSeconds / 86400).toFixed(2)} days old, past the client's ${(clientState.trustingPeriodSec / 86400).toFixed(2)}-day trusting period. Refusing rather than downgrading: an expired checkpoint is not a weaker checkpoint, it is one whose freshness assumption has failed and whose client may be abandoned.`);
  }

  return {
    ok: true,
    chain, hostChainId: C.chainId, clientId: C.clientId,
    revision, dydxHeight: height,
    // The two values that ARE the checkpoint.
    appHash: cons.appHash,
    nextValidatorsHash: cons.nextValidatorsHash,
    time: cons.time, timeSeconds: cons.timeSeconds,
    ageSeconds, expired,
    trustingPeriodSec: clientState.trustingPeriodSec,
    unbondingPeriodSec: clientState.unbondingPeriodSec,
    latestStoredHeight: clientState.latestHeight.height,
    historical: requestedHistorical,
    operators, operatorCount: operators.length,
    // Operators that are NOT already serving the dYdX side. Zero does not invalidate the checkpoint —
    // the counterparty's validator signatures are what make it unforgeable — but it means no new
    // independent observer was added, and that difference must not be quietly rounded up.
    disjointOperators: operators.filter((o) => !DYDX_RPC_OPERATORS.includes(o)),
    sharedOperators: operators.filter((o) => DYDX_RPC_OPERATORS.includes(o)),
    providers: ok.map((r) => r.rpc),
    byteIdentical,
    hostAppHashes: ok.map((r) => ({ operator: r.operator, height: r.queryHeight, appHash: r.hostAppHash })),
    hostSignatures: ok.map((r) => (r.signatures ? { operator: r.operator, verified: r.signatures.verified, failed: r.signatures.failed, powerFraction: r.signatures.powerFraction, twoThirds: r.signatures.twoThirds } : null)).filter(Boolean),
    hostSignaturesVerified: verifySignatures && ok.every((r) => r.signatures?.achieved),
    proofBytes: ok.reduce((a, r) => a + r.bytes, 0) + csOk.reduce((a, r) => a + r.bytes, 0),
    failures: errors,
    ms: Date.now() - t0,
  };
}

/**
 * Try the preferred chains and return the best checkpoint a real quorum of independent operators
 * proved. Every candidate is fetched, so the ones not chosen are still reported as `alternatives` and
 * can be compared — five disjoint validator sets agreeing is a stronger statement than one, and it
 * costs nothing to say so.
 *
 * RANKING, and the trade-off it encodes:
 *   1. chains that bring an operator DISJOINT from the dYdX RPC set (see DYDX_RPC_OPERATORS) —
 *      currently only osmosis. A checkpoint read through the same three companies adds a validator
 *      set but no new observer.
 *   2. then freshest. Relayer cadences differ wildly (measured p50: noble 313 s, osmosis 255 s with an
 *      18.6 h tail, injective a metronomic 3,600 s, neutron 2,606 s), and a stale checkpoint pushes
 *      the anchor deeper into dYdX's state-pruning window. See DEPTH_REGIMES.
 *
 * `preferDisjointOperators: false` reverses the priority to pure freshness, which is the right choice
 * when the anchor's depth matters more than adding an observer. It is an explicit argument because the
 * two goals genuinely conflict and neither default is right for every caller.
 */
export async function readBestCheckpoint({ chains = PREFERRED_CHAINS, timeoutMs = 25000, preferDisjointOperators = true, ...rest } = {}) {
  const results = await Promise.allSettled(chains.map((chain) => readCheckpoint({ chain, timeoutMs, ...rest })));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failures = results.map((r, i) => (r.status === 'rejected' ? `${chains[i]}: ${String(r.reason?.message ?? r.reason).slice(0, 200)}` : null)).filter(Boolean);
  if (!ok.length) throw new Error(`ibc-checkpoint: no preferred chain produced a corroborated checkpoint — ${failures.join(' | ')}`);
  ok.sort((a, b) => {
    if (preferDisjointOperators) {
      const d = (b.disjointOperators.length > 0 ? 1 : 0) - (a.disjointOperators.length > 0 ? 1 : 0);
      if (d !== 0) return d;
    }
    return b.dydxHeight - a.dydxHeight;
  });
  return {
    ...ok[0],
    alternatives: ok.slice(1).map((c) => ({ chain: c.chain, dydxHeight: c.dydxHeight, appHash: c.appHash, operators: c.operatorCount, disjointOperators: c.disjointOperators, ageSeconds: c.ageSeconds })),
    chainFailures: failures,
  };
}

// ---------------------------------------------------------------- historical checkpoint discovery

/**
 * List the dYdX heights a counterparty has actually STORED, newest first.
 *
 * ==> THIS IS DISCOVERY ONLY AND IS NOT PART OF THE TRUST CHAIN. <==
 * It reads the counterparty's REST/LCD endpoint, which is an ordinary trusted web server — exactly the
 * thing this module exists to stop relying on. Nothing it returns is believed: every height handed
 * back is subsequently proven by `readCheckpoint({ dydxHeight })`, and a fabricated height simply
 * fails to produce a proof. It is here because there is no way to enumerate IAVL keys over ABCI, and
 * a checkpoint at an arbitrary past height needs to know which heights exist.
 *
 * THE CONSTRAINT THIS EXPOSES, which is the real limit on historical checkpointing: a counterparty
 * holds only the heights its RELAYER submitted, not every height. Osmosis stores 15,059 states across
 * 255.9 days of dYdX — roughly one per 1,470 seconds, against a 0.608 s block time. So ~99.96% of dYdX
 * heights have NO checkpoint and never will. You cannot checkpoint a height you chose; you choose from
 * the heights that were checkpointed.
 *
 * Also note the LCD's encoding asymmetry, which has already produced one false "mismatch" report:
 * `root.hash` is base64 and `next_validators_hash` is HEX. Neither is read here — only heights are.
 */
export async function discoverStoredHeights({ chain = 'osmosis', limit = 20, olderThan = null, reverse = true, timeoutMs = 60000 } = {}) {
  const C = CHECKPOINT_CHAINS[chain];
  if (!C) throw new Error(`ibc-checkpoint: unknown chain "${chain}"`);
  if (!C.lcd) throw new Error(`ibc-checkpoint: no LCD recorded for ${chain}`);
  // `reverse:false, limit:1` is the cheap way to reach the OLDEST stored state — which is by definition
  // far past the trusting period and is therefore the honest source of a genuinely expired checkpoint.
  // Ascending pagination at a LARGE limit is the trap that silently truncated an earlier measurement
  // pass; at limit 1 there is nothing to truncate.
  const params = new URLSearchParams({ 'pagination.limit': String(limit), 'pagination.reverse': String(reverse) });
  const url = `${C.lcd}/ibc/core/client/v1/consensus_states/${C.clientId}?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`ibc-checkpoint: ${C.lcd} returned http ${res.status} for consensus-state discovery`);
  const j = await res.json();
  let heights = (j.consensus_states ?? []).map((s) => Number(s.height.revision_height));
  if (olderThan !== null) heights = heights.filter((h) => h < olderThan);
  return heights;
}

// ---------------------------------------------------------------- binding a checkpoint to an anchor

/** Route `checkpoint: true` / `{chain}` / `{chains}` to the right reader. */
export async function readCheckpointFor(opts = {}) {
  return opts.chain ? readCheckpoint(opts) : readBestCheckpoint(opts);
}

/**
 * The height an anchor must sit at to be covered by a checkpoint.
 *
 * `consensus_state(H).root` is `dydx header[H].app_hash`, and dydx-attest anchors state AFTER block
 * `height`, whose app_hash lives in header[height+1]. So height = H - 1, headerHeight = H. Off by one
 * here and the app_hash comparison fails closed, which is the correct direction to be wrong in, but it
 * would read as a chain disagreement rather than as arithmetic.
 */
export const anchorHeightFor = (checkpoint) => checkpoint.dydxHeight - 1;

/**
 * THE GATE ON `TRUST.CHECKPOINTED`. Every clause below is load-bearing; the label is returned only
 * when all of them hold, and this function throws rather than returning a weaker label, because a
 * caller that asked for a checkpoint and silently got a non-checkpointed anchor is the failure this
 * whole module exists to prevent.
 *
 *   1. the checkpoint height is EXACTLY the anchor's header height (no "close enough")
 *   2. the app_hash the ICS-23 proofs root into EQUALS the app_hash the counterparty committed to
 *   3. the counterparty's next_validators_hash matches the header's — a second, free binding that
 *      would catch a coincidental app_hash collision and confirms both sides describe one block
 *   4. >= minOperators independently operated counterparty providers proved it, byte-identical
 *      (enforced in readCheckpoint, re-asserted here so relaxing one site cannot relax the label)
 *   5. the checkpoint is inside its client's trusting period (enforced in readCheckpoint, LOUDLY)
 *   6. the counterparty client is not frozen (enforced in readCheckpoint)
 *
 * Returns the object to attach as `anchor.checkpoint`. Does not mutate.
 */
export function verifyAnchorCheckpoint(anchor, checkpoint, { minOperators = MIN_CHECKPOINT_OPERATORS } = {}) {
  if (!checkpoint?.ok) throw new Error('ibc-checkpoint: no checkpoint to verify against');

  if (checkpoint.dydxHeight !== anchor.headerHeight) {
    throw new Error(`ibc-checkpoint: checkpoint is for dYdX height ${checkpoint.dydxHeight} but the anchor's header height is ${anchor.headerHeight} — a checkpoint covers ONE height and nothing near it. Refusing.`);
  }
  const anchorApp = String(anchor.appHash).toUpperCase();
  if (checkpoint.appHash !== anchorApp) {
    throw new Error(`ibc-checkpoint: APP_HASH DISAGREEMENT at height ${checkpoint.dydxHeight} — ${checkpoint.chain} (${checkpoint.operators.join(', ')}) committed to ${checkpoint.appHash}, the dYdX RPCs served ${anchorApp}. One of them is lying and this module does not guess which. Refusing.`);
  }
  const headerNvh = anchor._header?.next_validators_hash ? String(anchor._header.next_validators_hash).toUpperCase() : null;
  if (headerNvh && checkpoint.nextValidatorsHash !== headerNvh) {
    throw new Error(`ibc-checkpoint: next_validators_hash disagreement at ${checkpoint.dydxHeight} — checkpoint ${checkpoint.nextValidatorsHash}, header ${headerNvh}. Refusing.`);
  }
  if (checkpoint.operatorCount < minOperators) {
    throw new Error(`ibc-checkpoint: checkpoint carries ${checkpoint.operatorCount} independent operator(s), need ${minOperators}`);
  }
  // Defence in depth, and it is not redundant: `readCheckpoint` establishes byte-identity, but this
  // function also accepts checkpoint objects that a caller assembled or passed through, and a flag
  // saying "corroborated" is not corroboration. Re-assert it where the LABEL is issued.
  if (!checkpoint.byteIdentical) {
    throw new Error(`ibc-checkpoint: checkpoint is not byte-identical across its ${checkpoint.operatorCount} operators — refusing to label a disputed value as checkpointed`);
  }
  if (checkpoint.expired) {
    throw new Error(`ibc-checkpoint: checkpoint is EXPIRED (${(checkpoint.ageSeconds / 86400).toFixed(2)} d > ${(checkpoint.trustingPeriodSec / 86400).toFixed(2)} d trusting period) — refusing to label an expired checkpoint as one`);
  }

  return {
    chain: checkpoint.chain,
    hostChainId: checkpoint.hostChainId,
    clientId: checkpoint.clientId,
    dydxHeight: checkpoint.dydxHeight,
    appHash: checkpoint.appHash,
    nextValidatorsHash: checkpoint.nextValidatorsHash,
    nextValidatorsHashMatched: !!headerNvh,
    time: checkpoint.time,
    ageSeconds: checkpoint.ageSeconds,
    trustingPeriodSec: checkpoint.trustingPeriodSec,
    expired: false,
    historical: checkpoint.historical,
    operators: checkpoint.operators,
    operatorCount: checkpoint.operatorCount,
    disjointOperators: checkpoint.disjointOperators,
    sharedOperators: checkpoint.sharedOperators,
    providers: checkpoint.providers,
    byteIdentical: checkpoint.byteIdentical,
    hostSignaturesVerified: checkpoint.hostSignaturesVerified,
    hostSignatures: checkpoint.hostSignatures,
    proofBytes: checkpoint.proofBytes,
    alternatives: checkpoint.alternatives ?? [],
    trust: TRUST.CHECKPOINTED,
    means: `dYdX app_hash ${checkpoint.appHash.slice(0, 12)}… at height ${checkpoint.dydxHeight} is the value ${checkpoint.hostChainId}'s own validators committed to in their IBC client ${checkpoint.clientId}, read out of ${checkpoint.hostChainId}'s IAVL store with an ICS-23 proof and corroborated byte-for-byte across ${checkpoint.operatorCount} independently operated providers. Forging it now requires >1/3 of dYdX staked power, slashably and on chain — not a malicious web server. It does NOT attest freshness, and it does not say the oracle price is correct.`,
  };
}

// ---------------------------------------------------------------- depth regimes
//
// The constraint that actually shapes this work is NOT IBC retention (255.9 days on Osmosis) and NOT
// the trusting period (18.7-25.5 days). It is dYdX RPC state pruning, and the reason it is easy to miss
// is that BLOCK retention and STATE retention are different windows on the same node.
//
// Measured 2026-07-28 against a live tip, `commit` at H+1 versus `abci_query prove=true` at H:
//
//   depth                       publicnode        kingnodes(x2)     polkachu
//   tip-3                       commit+proof      commit+proof      commit+proof
//   ~15 min  (1,480 blocks)     commit only       commit+proof      commit+proof
//   ~5 h     (29,600 blocks)    commit only       commit+proof      commit+proof
//   ~17 h    (100,000 blocks)   commit only       commit+proof      commit+proof
//   2 days   (284,058 blocks)   commit only       commit ONLY       commit+proof
//
// So `openAnchor` — which counts providers that served `commit` — reports THREE corroborators two days
// deep while exactly ONE operator on earth can serve the state proof there. That gap is invisible from
// inside openAnchor and is why `probeProofDepth` exists: the honest number is the count of operators
// that can prove state, not the count that can echo a header.
export const DYDX_STATE_RETENTION = [
  { operator: 'publicnode', url: 'https://dydx-rpc.publicnode.com', measuredProofDepthBlocks: 100, note: '~1 minute. Useful for the tip and nothing else.' },
  { operator: 'kingnodes', url: 'https://dydx-ops-rpc.kingnodes.com', measuredProofDepthBlocks: 99611, note: '~16.8 h' },
  { operator: 'kingnodes', url: 'https://dydx-rpc.kingnodes.com', measuredProofDepthBlocks: 100099, note: '~16.9 h. SAME OPERATOR as the line above — one witness, not two.' },
  { operator: 'polkachu', url: 'https://dydx-dao-rpc.polkachu.com', measuredProofDepthBlocks: 2468750, note: '~17.4 days' },
];
/** Measured over a 9,990-block span on 2026-07-28. */
export const DYDX_BLOCK_SECONDS = 0.608;

export const DEPTH_REGIMES = {
  LIVE: 'live',               // >=3 operators can prove state: within ~100 blocks of the tip
  RECENT: 'recent',           // 2 operators (kingnodes, polkachu): out to ~100k blocks / ~17 h
  ARCHIVE_ONLY: 'archive-only', // 1 operator (polkachu): beyond ~100k blocks. Corroboration is GONE.
  UNSERVED: 'unserved',       // 0 operators: beyond ~2.47M blocks / ~17.4 days
};

/**
 * Ask the dYdX providers, at the height actually anchored, WHICH of them can serve a state proof.
 *
 * Measured, not predicted from the table above: prune windows roll, and a table is a snapshot. The
 * table is documentation; this function is the ground truth for a given run.
 */
export async function probeProofDepth({ height, rpcs = DYDX_STATE_RETENTION, timeoutMs = 20000, key = null } = {}) {
  const be4 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
  const probeKey = key ?? Buffer.concat([Buffer.from('Price:'), be4(0)]);
  const results = await Promise.all(rpcs.map(async (r) => {
    try {
      const resp = (await jrpc(r.url, 'abci_query', {
        path: '/store/prices/key', data: Buffer.from(probeKey).toString('hex'), height: String(height), prove: true,
      }, timeoutMs)).response;
      const served = !(resp.code && Number(resp.code) !== 0) && !!resp.proofOps?.ops?.length;
      return { ...r, served, detail: served ? null : `code ${resp.code ?? 0} ${String(resp.log || '').slice(0, 60)}` };
    } catch (e) { return { ...r, served: false, detail: String(e.message).slice(0, 80) }; }
  }));
  const provingOperators = [...new Set(results.filter((r) => r.served).map((r) => r.operator))];
  const regime = provingOperators.length >= 3 ? DEPTH_REGIMES.LIVE
    : provingOperators.length === 2 ? DEPTH_REGIMES.RECENT
      : provingOperators.length === 1 ? DEPTH_REGIMES.ARCHIVE_ONLY : DEPTH_REGIMES.UNSERVED;
  return {
    height, regime, provingOperators, provingOperatorCount: provingOperators.length,
    endpoints: results.map((r) => ({ operator: r.operator, url: r.url, served: r.served, detail: r.detail })),
    // The distinction that openAnchor's corroborator count cannot see.
    note: 'operators able to serve an ICS-23 STATE proof at this height. Every dYdX endpoint measured serves `commit` far deeper than it serves state, so a header-based corroborator count overstates this number at depth.',
  };
}
