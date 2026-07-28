// inputClaims.js: the register of what Quiver can and cannot say about where its INPUTS came from,
// and the one chokepoint through which a sibling field reaches an envelope.
//
// The distinction this file exists to hold, because everything below collapses without it:
//
//   ENVELOPE attestation  = "Quiver computed this and stands behind the bytes." That is what
//                           proof.js already ships: a content hash, self-checks, and a secp256k1
//                           signature when a key is configured. It is honest and it is unrelated to
//                           where the numbers came from.
//   INPUT attestation     = "the mark price this answer consumed is the one the venue's own state
//                           holds." That exists for exactly two services, and only via Hyperliquid's
//                           HyperEVM precompiles and dYdX's ICS-23 store proofs. For ten services no
//                           mechanism exists at all (PHASE_D_RESEARCH.md §5).
//
// Conflating the two is the failure this project keeps catching: a guarantee stated over the general
// case that holds only over a subset. Gate D4 is the negative gate for it. It does not check that
// attestation works; it checks that the services which cannot attest do not SAY they can.
//
// Nothing here is deployed and nothing here touches src/engine/. `attachSibling` writes strictly
// beside `proof` / `observation` and keeps the same object reference for both, so the committed
// content hash cannot move as a side effect of attaching a disclosure.

export const CATEGORY = {
  AVAILABLE: 'available',           // a mechanism exists and is measured
  UNBUILT: 'possible-unbuilt',      // a mechanism demonstrably works but is not wired in
  PARTIAL: 'partial',               // a mechanism is measured over a SUBSET and not over the general case
  NONE: 'none',                     // no mechanism exists today, measured, not assumed
  NOT_NEEDED: 'not-needed',         // the caller supplied the inputs, or nothing external was read
};

/* Why PARTIAL exists, added after the first draft of this file was wrong.
 *
 * The register began with four categories and put `protocol-pulse` in NONE on the strength of
 * PHASE_D_RESEARCH.md §5. A parallel measurement (PHASE_D_HARD_CASES.md) then recomputed Aave v3
 * Ethereum TVL from chain state and landed 0.10% from DefiLlama's figure, which makes the quantity
 * reproducible for that protocol and for no other of the 7,938 DefiLlama lists. Forcing that into
 * either "none" or "possible-unbuilt" would state a guarantee over the general case that holds only
 * over a subset, which is the exact defect this whole register exists to catch. So it gets its own
 * category, and a PARTIAL entry is required to name its subset and what falls outside it.
 */

/**
 * Every service appears here EXACTLY ONCE. A service missing from this table is treated as an error
 * by gate D4 rather than as an implicit anything: forgetting to classify a new service must fail
 * closed, because the whole point of a negative gate is that silence is not a pass.
 *
 * `hosts` is the measured external-host list from PHASE_D_RESEARCH.md §1, which was parsed out of the
 * adapters rather than written by hand. Gate D4 re-derives host contact from source and compares.
 */
export const INPUT_ATTESTATION = {
  // ── a mechanism exists, and is partial. The gaps are part of the entry on purpose: an attestation
  //    that covers three of five consumed quantities and does not say which is the same overstatement
  //    in a smaller box.
  'perp-gate': {
    category: CATEGORY.AVAILABLE,
    hosts: ['api.hyperliquid.xyz', 'indexer.dydx.trade'],
    mechanism: 'Hyperliquid HyperEVM read precompiles (markPx 0x…0806, oraclePx 0x…0807, perpAssetInfo 0x…080a); dYdX v4 ICS-23 store proofs rooted in a validator-signed app_hash',
    covers: ['markPrice', 'oraclePrice', 'maxLeverage', 'szDecimals', 'dydx oraclePrice', 'dydx maintenanceMarginFraction'],
    gaps: [
      'fundingRateHourly on HYPERLIQUID: absent, and now for a structural reason rather than a failed search. Funding is an hourly time average of samples taken every few seconds; a precompile read is a point-in-time snapshot, so no precompile in the existing set could carry it. Only a new funding-rate precompile would.',
      'marginTiers: marginTableId is exposed, the table is not, and the engine PREFERS tiers over maxLeverage when it has them',
      'the off-chain form of this check is two unsigned HTTPS reads, so it is corroboration and not attestation until the comparison runs inside a HyperEVM contract',
    ],
    // CORRECTION, measured here on 28 Jul 2026 rather than inherited. PHASE_D_RESEARCH.md §4.2 and §5
    // both say dYdX funding "was not located in either store". It is in the store; the earlier probe
    // used the Go constant names and the wire prefixes are abbreviated. Measured against
    // dydx-rpc.publicnode.com at height 99,347,930:
    //   store/perpetuals key "PremSamples"     -> code 0, value 675 B, proof 1,382 B, ops
    //                                             [ics23:iavl, ics23:simple]  = EXISTENCE
    //   store/perpetuals key "PremVotes"       -> code 0, value 1,418 B, proof 2,121 B  = EXISTENCE
    //   store/perpetuals key "PremiumSamples"  -> code 0, value 0 B, proof 2,140 B      = NON-existence
    // The third line is the control: the old key name returns a non-existence proof, which is exactly
    // what a key-name error looks like and is why the earlier pass read as an absence.
    availableButUnwired: [
      'fundingHourly on DYDX: recoverable from store/perpetuals key PremSamples with a 2-op ICS-23 proof of the same shape src/adapters/ics23.js already verifies. PHASE_D_HARD_CASES.md reconstructs it exactly as mean(premium samples, sint32 ppm) / 8 / 1e6 across five snapshots; that reconstruction is THEIR measurement, the key existence and proof shape above are mine.',
    ],
    onlyInLiveBranch: true,
  },
  'portfolio-gate': {
    category: CATEGORY.AVAILABLE,
    hosts: ['api.hyperliquid.xyz'],
    mechanism: 'Hyperliquid HyperEVM read precompiles, including position(address,uint32) for the account book',
    covers: ['markPrice', 'oraclePrice', 'maxLeverage', 'positionSize', 'positionLeverage', 'positionEntryPrice (derived from entryNtl/szi)'],
    gaps: [
      'accountEquityUsd: 0x080f exists but has not been verified against a live book',
      'venueLiquidationPx: reported by clearinghouseState only, no precompile',
      'same off-chain caveat as perp-gate',
    ],
    onlyInLiveBranch: true,
  },

  // ── the mechanism is measured to work and is not wired in. Saying "possible" here rather than
  //    "available" is the difference the gate enforces.
  'lp-desk': {
    category: CATEGORY.UNBUILT,
    hosts: ['rpc.mevblocker.io', 'eth.api.onfinality.io', 'mainnet.base.org', 'arb1.arbitrum.io'],
    mechanism: 'eth_getProof against the block stateRoot; measured at about 6 KB per pool on the free RPCs already in use',
    reason: 'measured to work, not wired into the envelope, so no claim may be made',
  },
  'calldata-x': {
    category: CATEGORY.UNBUILT,
    hosts: ['12 public EVM RPCs', 'www.4byte.directory'],
    mechanism: 'eth_getProof; the adapter already records blockNumber and blockHash so the anchor is half built',
    reason: 'the eth_simulateV1 result is a counterfactual execution and is never committed state; only the state it ran against is provable, and that is not wired in either',
  },

  // ── no mechanism exists. Ten services. Each reason is a measurement, not a shrug.
  // Category unchanged, reason rewritten. Two things §5 says about this row do not survive
  // measurement, and neither changes the verdict, which is why the reason is corrected rather than
  // the category. (1) "373 KB, seven times past any published zkTLS benchmark" is a fact about what
  // has been BENCHMARKED, not a cost cliff: under TLSNotary's own model the 25 MB session floor is
  // 63% of the cost of proving the whole chain, and the front-expiry slice options-desk's headline
  // block actually reads is 18.5 KB, under every published benchmark. (2) §6 forbids a TEE-attested
  // Deribit fetch by analogy with DefiLlama TVL, and the analogy is false: TVL approximates an
  // external fact, whereas mark_iv IS Deribit's mark by definition, so for that quantity provenance
  // is the whole quantity. What is unchanged and is why this stays NONE: nothing is built, nothing is
  // measured working, and Deribit still signs nothing.
  'options-desk': {
    category: CATEGORY.NONE, hosts: ['www.deribit.com', 'www.okx.com', 'gamma-api.polymarket.com'],
    reason: 'Deribit is not a chain, signs nothing, and its response envelope (jsonrpc/id/result/testnet/usIn/usOut/usDiff) has no field a signature could occupy. No oracle publishes per-instrument mark IV or DVOL: a fresh scan of Pyth found 3,056 feeds and zero crypto implied-volatility feeds. Nothing is wired and nothing has been measured working, so no claim may be made. The obstacle is a decision by Deribit rather than a research problem, which is a different sentence from the one §5 wrote and lands in the same place.',
  },
  // CORRECTION. This entry read NONE on the first draft, on §5's "derived, methodology-dependent
  // aggregate" reasoning. That reasoning is about the wrong thing: DefiLlama's methodology is
  // published open-source adapter code, so the derivation from chain state to TVL is a public
  // deterministic function, which makes the quantity reproducible rather than merely transportable.
  // What keeps it out of UNBUILT is volume, not principle, and PARTIAL is the honest category.
  'protocol-pulse': {
    category: CATEGORY.PARTIAL, hosts: ['api.llama.fi'],
    mechanism: 'recompute TVL from chain state and prove that state with eth_getProof on the free RPCs lp-desk already uses',
    subset: 'protocols whose TVL is a function of EVM storage on a chain with eth_getProof. PHASE_D_HARD_CASES.md measured Aave v3 Ethereum at 67 of 67 reserves, landing 1.0010x DefiLlama. That recomputation is THEIR measurement and I did not repeat it.',
    outsideSubset: 'the other 7,937 protocols DefiLlama lists, each needing its own recomputation adapter, plus any protocol whose TVL depends on off-chain assets, oracle-priced illiquids, or cross-chain accounting where the counting convention is genuinely contestable',
    reason: 'a mechanism exists for a measured subset of one protocol and nothing is wired in, so no claim may be made for any protocol including that one',
    gaps: ['everything outside the measured subset', 'the counting convention itself, which is a specification disagreement and not a cryptography problem'],
    refetch: 'measured here: api.llama.fi/tvl/aave returns the current TVL scalar in 18 bytes against 10,173,949 bytes for /protocol/aave, so a cheap independent re-fetch of the headline number exists today',
  },
  'poly-fill': {
    category: CATEGORY.NONE, hosts: ['gamma-api.polymarket.com', 'clob.polymarket.com', 'data-api.polymarket.com'],
    reason: 'poly-fill walks the RESTING book (book.bids / book.asks) for a slippage estimate. Resting orders never touch a chain, exactly as dYdX documents for its own book. The /book hash field has no signer, is 20 bytes and SHA-1 shaped, and was not reproducible under any of 12 constructions tried. Even if Polymarket served the maker signatures it already holds, an order existing is not an order still resting, so depth would remain an upper bound.',
  },
  // CORRECTION. This entry read NONE on the first draft, inheriting poly-fill's reasoning. It is
  // wrong, because poly-desk does not read a book at all: it calls exactly deps.positions(wallet) and
  // deps.activity(wallet, 40), which are Conditional Tokens balances and transfer history, and those
  // are Polygon EVM storage. Measured here on 28 Jul 2026 against polygon-bor-rpc.publicnode.com,
  // eth_getProof on the CTF contract 0x4D97DCd9…6045: account proof 9 nodes / 3,847 B, storage proof
  // 7 nodes / 3,307 B, about 7.2 KB total. polygon-rpc.com did not answer. This is lp-desk with a
  // different contract address, so it belongs in UNBUILT.
  'poly-desk': {
    category: CATEGORY.UNBUILT, hosts: ['gamma-api.polymarket.com', 'clob.polymarket.com', 'data-api.polymarket.com'],
    mechanism: 'eth_getProof on Polygon against the Conditional Tokens contract, about 7.2 KB per slot, measured working on a free public RPC',
    reason: 'measured to work and not wired into the envelope, so no claim may be made. The service reads only wallet positions and activity, both of which are chain state; it never touches the resting book that makes poly-fill hard.',
  },
  // CORRECTION across all five OKX rows. The first draft repeated §5's "worst case" reasoning: that a
  // buyer cannot re-fetch without their own HMAC credentials, so not even the weak "go look yourself"
  // fallback exists. Measured here on 28 Jul 2026 with NO credentials of any kind, against
  // web3.okx.com/api/v6/dex/…:
  //
  //   market/trades              402  x402 v2, payPerUse true, amount "100"
  //   market/candles             402  x402 v2, payPerUse true, amount "100"
  //   token/advanced-info        402  x402 v2, payPerUse true, amount "200"
  //   portfolio/overview         402  x402 v2, payPerUse true, amount "200"
  //   portfolio/recent-pnl       402  x402 v2, payPerUse true, amount "200"
  //   market/holders             404  the endpoint does not exist
  //   portfolio/dex-history      401  code 50103, OK-ACCESS-KEY required. The only credential-locked one.
  //
  // Asset 0x4ae46a509f6b1d9056937ba4500cb143933d2dc8 on eip155:196 (X Layer). I read decimals() on
  // that contract directly and it returned 6, so "100" is $0.0001 and "200" is $0.0002. No payment was
  // executed and none should be. Control: www.okx.com/api/v5/market/candles returned 200 with no
  // credential, so chart-press's CEX branch was never keyed at all.
  //
  // THE CATEGORY DOES NOT CHANGE, and the distinction matters. A re-fetch is not an attestation: the
  // responses are still unsigned JSON, and §2 of the research already measured that ordinary drift
  // exceeds any useful attestation bound inside a minute, so re-fetching is a concurrent check rather
  // than an audit. What was false was the stated REASON, and a register whose reasons are false is a
  // register nobody should trust the categories of.
  'updown-pulse': {
    category: CATEGORY.NONE, hosts: ['gamma-api.polymarket.com', 'clob.polymarket.com', 'web3.okx.com'],
    reason: 'a Polymarket resting book plus an OKX DEX read. Neither is signed and neither is chain state. The Polymarket half is poly-fill\'s problem and the OKX half is unsigned JSON.',
    refetch: 'partial: the OKX half is re-fetchable at $0.0001 via x402, the Polymarket book is free to re-fetch and equally unsigned',
  },
  'chart-press': {
    category: CATEGORY.NONE, hosts: ['web3.okx.com', 'www.okx.com'],
    reason: 'OKX signs inbound requests, never responses. Its Compound-compatible Get oracle endpoint went offline 2025-01-07 and now returns 404 while auth-gated routes return 50103, which is the control showing removal rather than gating.',
    refetch: 'yes, and it is the best-provisioned of the five: the CEX branch is keyless (measured 200 with no credential) and the DEX branch serves x402 at $0.0001',
  },
  'tape-pulse': {
    category: CATEGORY.NONE, hosts: ['web3.okx.com'], keyed: true,
    reason: 'unsigned JSON. Quiver reads it with HMAC credentials, and the response carries no signature of any kind, so there is nothing to attest against.',
    refetch: 'yes, $0.0001 per call via x402 on market/trades, with no dev-portal account. The ground truth underneath is public Swap events, which an independent verifier can recompute rather than re-fetch.',
  },
  'token-scan': {
    category: CATEGORY.NONE, hosts: ['web3.okx.com'], keyed: true,
    reason: 'unsigned JSON, same as tape-pulse.',
    refetch: 'yes for token/advanced-info at $0.0002 via x402. market/holders returns 404 and does not exist.',
  },
  'wallet-audit': {
    category: CATEGORY.NONE, hosts: ['web3.okx.com'], keyed: true,
    reason: 'unsigned JSON, same as tape-pulse.',
    refetch: 'yes, $0.0002 via x402 on both portfolio/overview and portfolio/recent-pnl',
  },
  'loop-digest': {
    category: CATEGORY.NONE, hosts: ['web3.okx.com'], keyed: true,
    reason: 'unsigned JSON, same as tape-pulse.',
    refetch: 'NO. portfolio/dex-history returns 401 code 50103 and is the single genuinely credential-locked endpoint across all five services. §5 said this of all five; it is true of exactly this one.',
  },

  // ── nothing to attest. Seven proof-only engines whose inputs the caller supplied, plus the one
  //    service that contacts nothing at all.
  'size-gate': { category: CATEGORY.NOT_NEEDED, hosts: [], reason: 'caller-supplied inputs, echoed in the proof envelope and re-runnable from source. There is no upstream read to attest.' },
  'exec-verify': { category: CATEGORY.NOT_NEEDED, hosts: [], reason: 'caller-supplied inputs. The caller states amountIn and amountOutRealized; nothing is fetched, so provenance is the caller\'s and not Quiver\'s to vouch for.' },
  'options-risk': { category: CATEGORY.NOT_NEEDED, hosts: [], reason: 'caller-supplied positions. Nothing is fetched, so there is no upstream read to attest; the risk is model risk, which no attestation addresses.' },
  'lp-risk': { category: CATEGORY.NOT_NEEDED, hosts: [], reason: 'caller-supplied pool state. Nothing is fetched. If the caller sourced it from lp-desk, the attestation question belongs to that call and not this one.' },
  'treasury-risk': { category: CATEGORY.NOT_NEEDED, hosts: [], reason: 'caller-supplied positions. Nothing is fetched, so there is no upstream read to attest.' },
  'risk-attest': { category: CATEGORY.NOT_NEEDED, hosts: [], reason: 'caller-supplied content hashes. It batches them into a Merkle root and says nothing whatever about where those hashes came from or what inputs produced them.' },
  'event-vol': { category: CATEGORY.NOT_NEEDED, hosts: [], reason: 'caller-supplied spot and event parameters. Nothing is fetched, so there is no upstream read to attest.' },
  'macro-sentry': {
    category: CATEGORY.NOT_NEEDED, hosts: [],
    reason: 'contacts nothing. A curated static calendar filtered against wall-clock now; it is an observation because time moved, not because a venue was read.',
  },
};

/**
 * The census, as measured. Gate D4 requires the register to still produce exactly this.
 *
 * PHASE_D_RESEARCH.md §5 and the first draft of this file both had {available 2, unbuilt 2, none 10,
 * not-needed 8}. Two rows moved on measurement: `poly-desk` from none to possible-unbuilt (Polygon
 * eth_getProof measured working on the Conditional Tokens contract), and `protocol-pulse` from none
 * to partial (TVL recomputable from chain state for a measured subset of one protocol). So the
 * research sentence "ten have no mechanism" is now eight.
 */
export const EXPECTED_CENSUS = { available: 2, 'possible-unbuilt': 3, partial: 1, none: 8, 'not-needed': 8 };

export function census(reg = INPUT_ATTESTATION) {
  const c = {};
  for (const v of Object.values(reg)) c[v.category] = (c[v.category] || 0) + 1;
  return c;
}

export const servicesIn = (cat, reg = INPUT_ATTESTATION) =>
  Object.keys(reg).filter((k) => reg[k].category === cat).sort();

/**
 * True only for a service with a measured mechanism. Everything else is refused by attachSibling.
 *
 * PARTIAL is included deliberately, and attachSibling then demands MORE of it than of AVAILABLE: a
 * partial entry has to declare its subset in the sibling as well as its gaps. Excluding PARTIAL
 * outright would have been the easy call and the wrong one, because it would make the gate a ban on
 * telling the truth about a subset rather than a check that the truth is fully told.
 */
export function mayCarryInputAttestation(service, reg = INPUT_ATTESTATION) {
  const c = reg[service]?.category;
  return c === CATEGORY.AVAILABLE || c === CATEGORY.PARTIAL;
}

/* ───────────────────────────── the claim scanner ─────────────────────────────
 *
 * A claim is not only a field called `attestation`. It is any wording a reader converts into "the
 * input was checked against something authoritative". The scanner therefore looks at KEY NAMES and at
 * STRING VALUES, at any depth, inside arrays, and reports every hit with its JSON path rather than a
 * boolean, so a failure names the offending field instead of asserting that one exists somewhere.
 */
export const CLAIM_KEY_PATTERNS = [
  /attest/i, /attested/i, /inputproof/i, /stateproof/i, /consensusproof/i,
  /verifiedinput/i, /inputverif/i, /sourceproof/i, /venueproof/i, /provenance(proof|attest)/i,
];

export const CLAIM_PHRASES = [
  'attested', 'attestation', 'attests', 'cryptographically verified',   // 'attested' subsumes 'is attested'; keeping both only doubled the reports
  'verified against the venue', 'verified against consensus', 'proof of input', 'proven correct',
  'proves the input', 'confirms the input', 'confirms the price', 'guaranteed correct',
  'certified', 'authenticated by the venue', 'the venue signed', 'signed by the venue',
];

/** Words that turn a measurement into a truth claim. Kept apart from CLAIM_PHRASES because these are
 *  what a DISCLOSURE must never say, whereas the above are what a NON-ATTESTING service must never say. */
export const CORRECTNESS_WORDS = [
  'proves correct', 'proves the number', 'confirms correctness', 'confirms the number is',
  'guarantees the number', 'therefore correct', 'so the price is correct', 'validates the price',
];

function walk(value, path, visit, seen = new Set()) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') { visit(path, value, 'value'); return; }
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`, visit, seen)); return; }
  for (const k of Object.keys(value)) {
    visit(`${path}.${k}`, k, 'key', value[k]);
    walk(value[k], `${path}.${k}`, visit, seen);
  }
}

/* Negation, and why it has to be here.
 *
 * The first run of gate D4 went red on this module's OWN output: a disclosure that says "this is a
 * disclosure, not an attestation" and carries `isAttestation: false` was flagged as making an
 * attestation claim. A scanner that cannot tell a denial from a claim forces its allowlist to grow
 * until it swallows everything, and then the gate is green forever regardless of what ships. So:
 *
 *   - a key matching a claim pattern whose value is literally `false` is a DENIAL
 *   - a phrase preceded, WITHIN ITS OWN SENTENCE, by a negator is a DENIAL
 *
 * The sentence clip is the part that matters. Without it, "This is not a signature. The input is
 * attested." would read as a denial because a `not` sits 30 characters earlier. With it, the second
 * sentence is scanned on its own and the claim is caught. That case is a test in gate D4.3.
 */
const NEGATORS = [' not ', 'not ', ' never ', 'never ', ' no ', 'cannot ', "n't ", 'nothing ', 'neither ', 'without ', 'refuses to '];

function negatedInSentence(text, idx) {
  const upto = text.slice(0, idx).toLowerCase();
  const cut = Math.max(upto.lastIndexOf('.'), upto.lastIndexOf(';'), upto.lastIndexOf('!'), upto.lastIndexOf('?'), upto.lastIndexOf('\n'));
  const sentence = ' ' + upto.slice(cut + 1);
  return NEGATORS.some((n) => sentence.includes(n));
}

/**
 * Scan an arbitrary value for input-attestation claims. Every occurrence is reported, not just the
 * first per string, so an early denial cannot mask a later claim in the same paragraph.
 * @returns [{ path, kind: 'key'|'value', matched, sample }]  empty array = clean
 */
export function scanClaims(value, { root = '', phrases = CLAIM_PHRASES, keyPatterns = CLAIM_KEY_PATTERNS } = {}) {
  const hits = [];
  walk(value, root, (path, text, kind, keyValue) => {
    if (kind === 'key') {
      if (keyValue === false) return;                        // `isAttestation: false` denies, it does not claim
      for (const re of keyPatterns) if (re.test(text)) { hits.push({ path, kind, matched: String(re), sample: text }); return; }
      return;
    }
    const low = text.toLowerCase();
    for (const p of phrases) {
      let i = low.indexOf(p);
      while (i >= 0) {
        if (!negatedInSentence(text, i)) { hits.push({ path, kind, matched: p, sample: text.slice(Math.max(0, i - 60), i + 100) }); break; }
        i = low.indexOf(p, i + p.length);
      }
    }
  });
  return hits;
}

/** Scan for wording that would turn a divergence measurement into a correctness claim. */
export const scanCorrectnessClaims = (value, opts = {}) =>
  scanClaims(value, { phrases: CORRECTNESS_WORDS, keyPatterns: [], ...opts });

/* ───────────────────────────── the envelope allowlist ─────────────────────────────
 *
 * proof.js legitimately uses this vocabulary about the ENVELOPE. Those paths are enumerated here,
 * measured by walking a real envelope rather than recalled, so that a NEW attestation-flavoured field
 * appearing anywhere in the envelope makes gate D4 go red and a human decide. A scanner with no
 * allowlist would fire on honest code, and a detector that fires on everything is not a detector.
 */
// Measured, at both T0 and T1, by gate D4.2 rather than recalled. It was three entries longer on the
// first draft and the gate rejected the extras as dead permissions: a permission nothing uses is a
// hole waiting for something to grow into it.
export const ENVELOPE_CLAIM_ALLOWLIST = new Set([
  '.proof.attestation',      // key name; the value describes the T0/T1 ENVELOPE tier, never the input
  '.observation.semantics',  // "Anchor contentHash on-chain (e.g. an EAS attestation) to timestamp what was served"
]);

/** The envelope-level vocabulary is allowed to say "Quiver signed this". It is NOT allowed to say
 *  anything about where the inputs came from. These are the phrases that would cross that line. */
export const INPUT_SCOPE_PHRASES = [
  'input is attested', 'inputs are attested', 'attested input', 'attested inputs',
  'the venue attests', 'venue-attested', 'attested against', 'verified against the venue',
  'the mark price is attested', 'source is attested', 'upstream is attested',
];

/**
 * The whole-envelope check gate D4 runs. Two layers:
 *   1. any attestation-flavoured path OUTSIDE the allowlist is a finding
 *   2. any allowlisted path that starts making claims about the INPUT is a finding
 */
export function scanEnvelope(envelope, { allowlist = ENVELOPE_CLAIM_ALLOWLIST } = {}) {
  const findings = [];
  for (const h of scanClaims(envelope)) {
    if (!allowlist.has(h.path)) findings.push({ ...h, why: 'attestation vocabulary at a path that is not on the measured allowlist' });
  }
  walk(envelope, '', (path, text, kind) => {
    if (kind !== 'value' || !allowlist.has(path)) return;
    const low = text.toLowerCase();
    for (const p of INPUT_SCOPE_PHRASES) {
      let i = low.indexOf(p);
      while (i >= 0) {
        if (!negatedInSentence(text, i)) { findings.push({ path, kind, matched: p, sample: text.slice(Math.max(0, i - 60), i + 100), why: 'an envelope-scope field making an INPUT-scope claim' }); break; }
        i = low.indexOf(p, i + p.length);
      }
    }
  });
  return findings;
}

/* ───────────────────────────── the chokepoint ───────────────────────────── */

export class InputClaimError extends Error {}

const HASHED_KEYS = new Set(['proof', 'observation']);

/**
 * Attach a sibling field to an envelope.
 *
 * Everything a service wants to say alongside its answer goes through here, so there is exactly one
 * place that can be reviewed and exactly one place a scripted revert can neuter. It:
 *   - refuses to write `proof` or `observation`, which are the hashed parts
 *   - keeps the SAME object reference for the hashed part, so the content hash cannot move
 *   - refuses any sibling containing input-attestation vocabulary unless the service has a measured
 *     mechanism AND the caller asked for it explicitly AND the sibling names its gaps
 *
 * @returns a new envelope object. The input is never mutated.
 */
export function attachSibling(envelope, key, value, { service, allowAttestation = false, registry = INPUT_ATTESTATION } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new InputClaimError('attachSibling: envelope must be an object');
  if (typeof key !== 'string' || !key) throw new InputClaimError('attachSibling: key must be a non-empty string');
  if (HASHED_KEYS.has(key)) throw new InputClaimError(`attachSibling: refusing to write "${key}". That is the hashed part of the envelope`);
  if (key in envelope) throw new InputClaimError(`attachSibling: "${key}" already present; refusing to overwrite`);
  if (!service || !registry[service]) throw new InputClaimError(`attachSibling: unknown service "${service}". A service absent from the input-attestation register fails closed`);

  // Scan `{ [key]: value }` and NOT `value`. The first version scanned only the payload, so
  // `attachSibling(env, 'inputAttestation', { venue: 'deribit', markIv: 0.55 })` sailed straight
  // through: the claim was entirely in the FIELD NAME, which is precisely the edit §6 names as the
  // thing D4 exists to stop. Gate D4.4 caught it on its first run.
  const hits = scanClaims({ [key]: value });
  if (hits.length) {
    // THE NEGATIVE GATE'S SUBJECT. If this branch stops refusing, D4 goes red.
    if (!allowAttestation) {
      throw new InputClaimError(
        `attachSibling: "${key}" makes an input-attestation claim but allowAttestation was not requested. Offending: ${hits.map((h) => h.path).join(', ')}`);
    }
    if (!mayCarryInputAttestation(service, registry)) {
      throw new InputClaimError(
        `attachSibling: "${key}" makes an input-attestation claim for "${service}", which has no attestation mechanism (${registry[service].category}). `
        + `Reason on record: ${registry[service].reason || 'none given'}. Offending: ${hits.map((h) => h.path).join(', ')}`);
    }
    const entry = registry[service];
    const gaps = entry.gaps || [];
    if (!gaps.length) throw new InputClaimError(`attachSibling: "${service}" may attest but its register entry lists no gaps; an attestation with no stated coverage limit is the overstatement this refuses`);
    const declared = value && typeof value === 'object' ? (value.gaps || value.notCovered || value.uncovered) : null;
    if (!Array.isArray(declared) || declared.length === 0) {
      throw new InputClaimError(`attachSibling: an input attestation for "${service}" must carry its own \`gaps\` array naming what it does NOT cover (${gaps.length} known: ${gaps.map((g) => g.split(':')[0]).join(', ')})`);
    }
    // A partial mechanism has to say what it covers as well as what it misses, because "attested"
    // beside a figure derived from one of 7,938 protocols is a claim about the other 7,937 unless
    // the subset is named in the same breath.
    if (entry.category === CATEGORY.PARTIAL) {
      const subset = value && typeof value === 'object' ? value.subset : null;
      if (typeof subset !== 'string' || subset.length < 10) {
        throw new InputClaimError(`attachSibling: "${service}" is a PARTIAL mechanism, so the sibling must carry a \`subset\` string naming what it holds for. On record: ${entry.subset}`);
      }
    }
  }

  const out = { ...envelope, [key]: value };
  // Identity, not deep equality: the hashed sub-object must be the very same reference it was.
  for (const k of HASHED_KEYS) if (k in envelope && out[k] !== envelope[k]) throw new InputClaimError(`attachSibling: "${k}" was replaced; the content hash would move`);
  return out;
}

/** Convenience wrapper for the divergence sibling, which is never an attestation for any service. */
export function withDivergenceDisclosure(envelope, disclosure, { service } = {}) {
  return attachSibling(envelope, 'divergence', disclosure, { service, allowAttestation: false });
}
