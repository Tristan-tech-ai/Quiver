// risk-attest — batch many proof content-hashes into ONE Merkle root, so a single on-chain anchor (the
// user's tx) attests all of them at once. This is the T2 direction made cheap: instead of one chain write
// per computation, an agent collects the content-hashes from its risk calls over an hour, roots them here,
// and anchors the root. Anyone then proves a specific computation was attested with a small inclusion proof.
//
// GROUND TRUTH & SELF-CHECKS (the discipline): a Merkle proof must be COMPLETE (every real leaf verifies
// against the root) and SOUND (a non-member leaf must NOT verify). Both are asserted on every call — if the
// tree/proof code were wrong, one of them fails loudly. sha256, sorted-pair (OpenZeppelin-compatible), so
// verification is order-independent and re-implementable by any counterparty.
import { createHash } from 'node:crypto';
import { signEip712, verifyEip712, _internal } from './proof.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hashPair = (a, b) => sha256(a <= b ? a + b : b + a); // sorted -> order-independent

function buildTree(leaves) {
  const layers = [leaves.slice()];
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

export function verifyInclusion(leaf, proof, root) {
  let h = leaf;
  for (const sib of proof) h = hashPair(h, sib);
  return h === root;
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

  const { root, layers } = buildTree(leaves);
  const attestations = leaves.map((leaf, i) => ({ index: i, leaf, proof: proofFor(layers, i) }));

  // Self-checks: completeness (all verify) + soundness (a fabricated non-member does not).
  const allVerify = attestations.every((a) => verifyInclusion(a.leaf, a.proof, root));
  const nonMember = sha256(leaves[0] + '::not-a-member');
  const soundness = !verifyInclusion(nonMember, attestations[0].proof, root);

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
    algorithm: 'sha256, sorted-pair binary Merkle (OpenZeppelin-compatible)',
    attestations: attestations.map((a) => ({ index: a.index, contentHash: '0x' + a.leaf, proof: a.proof.map((p) => '0x' + p) })),
    anchor: {
      instruction: `Anchor merkleRoot on-chain in one transaction from your wallet to attest all ${leaves.length} computations at once. Publish the root; anyone then verifies a computation was attested by checking its inclusion proof against the anchored root — no trust in Quiver.`,
      note: 'The on-chain write is yours (Quiver never holds your keys). This service prepares the root and proofs; it does not broadcast.',
    },
    verify: 'For a computation with contentHash L and its proof P: fold sha256(sorted(h, sibling)) up P; the result equals merkleRoot iff L was in the attested batch.',
    ...(easAttestation ? { easAttestation } : {}),
    checks: [
      { name: 'completeness: every leaf verifies against the root', pass: allVerify },
      { name: 'soundness: a fabricated non-member leaf does NOT verify', pass: soundness },
      ...(easAttestation ? [{ name: 'EIP-712 attestation signature recovers to the Quiver signer', pass: easVerifyOk === true }] : []),
    ],
  };
}
