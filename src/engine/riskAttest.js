// risk-attest — batch many proof content-hashes into ONE Merkle root, so a single on-chain anchor (the
// user's tx) attests all of them at once. This is the T2 direction made cheap: instead of one chain write
// per computation, an agent collects the content-hashes from its risk calls over an hour, roots them here,
// and anchors the root. Anyone then proves a specific computation was attested with a small inclusion proof.
//
// GROUND TRUTH & SELF-CHECKS (the discipline): a Merkle proof must be COMPLETE (every real leaf verifies
// against the root) and SOUND (a non-member leaf must NOT verify). Both are asserted on every call — if the
// tree/proof code were wrong, one of them fails loudly. sha256 over packed 32-byte words, sorted pairs, with domain-separated leaves and nodes, so
// verification is order-independent and re-implementable by any counterparty.
import { createHash } from 'node:crypto';
import { signEip712, verifyEip712, _internal } from './proof.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Hashing over PACKED 32-BYTE WORDS, not over hex text. An adversarial live test showed the earlier
// version folded ASCII hex strings, which makes a proof unverifiable by any on-chain verifier that
// hashes bytes — the arithmetic was self-consistent and useless to the one consumer that matters.
const bytes = (hex) => Buffer.from(hex, 'hex');

// DOMAIN SEPARATION. Leaves are tagged 0x00 and internal nodes 0x01, so an internal node cannot be
// presented as a member leaf. Without it, any node in the tree verifies against the root with a
// one-element proof — a soundness break in the only service whose purpose is proving membership.
const LEAF_TAG = Buffer.from([0x00]);
const NODE_TAG = Buffer.from([0x01]);
const hashLeaf = (hex) => sha256(Buffer.concat([LEAF_TAG, bytes(hex)]));
const hashPair = (a, b) => {
  const [lo, hi] = a <= b ? [a, b] : [b, a]; // sorted -> order-independent, as on-chain verifiers expect
  return sha256(Buffer.concat([NODE_TAG, bytes(lo), bytes(hi)]));
};

function buildTree(leafHashes) {
  const layers = [leafHashes.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]); // odd -> promote
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], layers };
}

function proofFor(layers, index) {
  const proof = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const sib = idx ^ 1;
    if (sib < layer.length) proof.push(layer[sib]); // no element when the node was promoted (no sibling)
    idx = Math.floor(idx / 2);
  }
  return proof;
}

// `leaf` is the raw contentHash (hex, no 0x). It is tagged as a leaf before folding, which is what
// makes an internal node fail here instead of verifying.
export function verifyInclusion(leaf, proof, root) {
  let h = hashLeaf(String(leaf).replace(/^0x/, '').toLowerCase());
  for (const sib of proof) h = hashPair(h, String(sib).replace(/^0x/, '').toLowerCase());
  return h === String(root).replace(/^0x/, '').toLowerCase();
}

const normalizeHash = (h) => (typeof h === 'string' ? h.replace(/^0x/, '').toLowerCase() : null);

export function riskAttest(input = {}) {
  const items = Array.isArray(input.items) ? input.items
    : (Array.isArray(input.contentHashes) ? input.contentHashes : []);
  const leaves = items.map((it) => {
    if (typeof it === 'string') return normalizeHash(it);
    return normalizeHash(it?.proof?.contentHash || it?.contentHash);
  }).filter(Boolean);
  if (!leaves.length) return { ok: false, errors: ['need items: an array of content-hashes (hex) or proof envelopes carrying proof.contentHash'] };
  // A duplicate leaf is almost always a mistake (two identical computations attested twice) — disclose it.
  const dupes = leaves.length - new Set(leaves).size;

  // The tree is built over TAGGED leaves; `leaves` stays the caller's content-hashes so proofs and
  // attestations are reported in the caller's own terms.
  const { root, layers } = buildTree(leaves.map(hashLeaf));
  const attestations = leaves.map((leaf, i) => ({ index: i, leaf, proof: proofFor(layers, i) }));

  // Self-checks: completeness, plus TWO soundness checks. The first (a random non-member) is the easy
  // one and cannot catch a structural break. The second presents an INTERNAL NODE as a member leaf —
  // the attack that actually worked against the pre-fix tree — so this check can fail in the direction
  // that matters. A verifier that cannot fail is the failure mode this whole service exists to avoid.
  const allVerify = attestations.every((a) => verifyInclusion(a.leaf, a.proof, root));
  const nonMember = sha256(leaves[0] + '::not-a-member');
  const soundness = !verifyInclusion(nonMember, attestations[0].proof, root);
  const internalNode = layers.length > 2 ? layers[1][0] : null; // a real node, one level above the leaves
  const nodeSibling = layers.length > 2 && layers[1].length > 1 ? [layers[1][1]] : [];
  const soundnessNode = internalNode === null ? true : !verifyInclusion(internalNode, nodeSibling, root);

  // EIP-712 typed attestation over the root — EAS-ready (parseable NAMED fields, not an opaque hash). When a
  // signing key is configured this is a standards-based attestation any wallet/contract/EAS can read; the
  // on-chain schema registration + attestation are the operator's write to make (Quiver never holds keys).
  const easDomain = { name: 'Quiver', version: '1', chainId: Number(process.env.EAS_CHAIN_ID) || 8453 }; // Base
  const easTypes = { QuiverRiskAttestation: [{ name: 'merkleRoot', type: 'bytes32' }, { name: 'itemCount', type: 'uint256' }, { name: 'engineVersion', type: 'string' }] };
  const easMessage = { merkleRoot: '0x' + root, itemCount: leaves.length, engineVersion: _internal.buildId() };
  const easSig = signEip712(easDomain, easTypes, easMessage);
  let easAttestation = null, easVerifyOk = null;
  if (easSig) {
    easVerifyOk = verifyEip712(easDomain, easTypes, easMessage, easSig.signature) === easSig.signer;
    easAttestation = {
      standard: 'EIP-712 typed data (EAS-ready)',
      schema: 'bytes32 merkleRoot,uint256 itemCount,string engineVersion',
      domain: easDomain, message: easMessage, signature: easSig.signature, signer: easSig.signer,
      verify: `ethers.verifyTypedData(domain, {QuiverRiskAttestation:[{name:'merkleRoot',type:'bytes32'},{name:'itemCount',type:'uint256'},{name:'engineVersion',type:'string'}]}, message, signature) === "${easSig.signer}"`,
      note: 'A parseable, standards-based attestation over the batch root — unlike an opaque signed hash, wallets/contracts and the Ethereum Attestation Service can read its named fields. Register this schema on EAS (Base) and submit {message, signature} to anchor it on-chain; that write is yours (Quiver holds no keys).',
    };
  }

  return {
    ok: true,
    merkleRoot: '0x' + root,
    leafCount: leaves.length,
    duplicateLeaves: dupes,
    algorithm: 'sha256 over PACKED 32-byte words, sorted pairs, domain-separated: leaf = sha256(0x00 || contentHash), node = sha256(0x01 || min(a,b) || max(a,b)). NOT OpenZeppelin MerkleProof-compatible, which folds keccak256 without a domain tag — an on-chain verifier for this tree is a short loop using the sha256 precompile (address 0x02), given below.',
    attestations: attestations.map((a) => ({ index: a.index, contentHash: '0x' + a.leaf, proof: a.proof.map((p) => '0x' + p) })),
    anchor: {
      instruction: `Anchor merkleRoot on-chain in one transaction from your wallet to attest all ${leaves.length} computations at once. Publish the root; anyone then verifies a computation was attested by checking its inclusion proof against the anchored root — no trust in Quiver.`,
      note: 'The on-chain write is yours (Quiver never holds your keys). This service prepares the root and proofs; it does not broadcast.',
    },
    verify: 'For contentHash L (32 bytes) and proof P: h = sha256(0x00 || L); then for each sibling s in P, h = sha256(0x01 || min(h,s) || max(h,s)) comparing as byte strings; h equals merkleRoot iff L was in the batch. Solidity: bytes32 h = sha256(abi.encodePacked(bytes1(0x00), leaf)); for (uint i; i < p.length; ++i) { h = h <= p[i] ? sha256(abi.encodePacked(bytes1(0x01), h, p[i])) : sha256(abi.encodePacked(bytes1(0x01), p[i], h)); } return h == root;',
    ...(easAttestation ? { easAttestation } : {}),
    checks: [
      { name: 'completeness: every leaf verifies against the root', pass: allVerify },
      { name: 'soundness: a fabricated non-member leaf does NOT verify', pass: soundness },
      { name: 'soundness: an INTERNAL NODE presented as a member leaf does NOT verify (domain separation holds)', pass: soundnessNode },
      ...(easAttestation ? [{ name: 'EIP-712 attestation signature recovers to the Quiver signer', pass: easVerifyOk === true }] : []),
    ],
  };
}
