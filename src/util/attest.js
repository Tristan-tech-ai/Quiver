// Signing the PUBLIC SIGNALS, so a contract can check two independent things.
//
// A succinct proof says "this liquidation price satisfies the identity for this position". It does
// not say "Quiver sold this". The envelope signature says the opposite: it says Quiver stands behind
// a content hash, but a content hash is a SHA-256 over canonical JSON and nothing on-chain can
// recompute it. Pair the two naively and you get a gap you could drive a position through — a valid
// proof of one position beside a valid signature over another, each checking out on its own.
//
// So the service signs the eight field elements themselves, under the same key that signs the
// envelope. On-chain the contract hashes the same eight words and recovers the signer, which closes
// the gap: the numbers the SNARK proved and the numbers Quiver attested to are the same numbers,
// byte for byte, and neither claim leans on the other.
//
// The key-reading logic below is a deliberate copy of the engine's, not an import. src/engine is
// hashed into the build id that every published proof and every document quotes; adding an export
// there would move that hash and stale the appendix, the paper and the signature over it — for no
// behavioural gain. Ten duplicated lines are cheaper than that, and the duplication is bounded
// because it reads one env var and normalises it the one way.
import { SigningKey, computeAddress, keccak256, solidityPacked, hashMessage, getBytes } from 'ethers';

let SIGNER;   // undefined = unchecked, null = no key configured, object = usable
function signer() {
  if (SIGNER !== undefined) return SIGNER;
  const raw = process.env.QUIVER_SIGNING_KEY;
  if (!raw) { SIGNER = null; return null; }
  let k = String(raw).trim();
  while (/^0x/i.test(k)) k = k.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(k)) { SIGNER = null; return null; }
  try {
    const sk = new SigningKey('0x' + k);
    SIGNER = { sk, address: computeAddress(sk.publicKey) };
  } catch { SIGNER = null; }
  return SIGNER;
}

/**
 * keccak256(abi.encodePacked(uint256[N])) — exactly what a verifier recomputes from calldata.
 *
 * THE LENGTH USED TO BE THE LITERAL 8, AND THAT SILENTLY DISARMED THE SECOND AND THIRD CIRCUITS.
 * Eight is the liquidation circuit's signal count; the Kelly circuit publishes five and the
 * concentration circuit twelve. So `length !== 8` returned null for both, `attestSignals` returned
 * null with it, and every Kelly and Herfindahl proof shipped `signalsAttestation: null` — which is
 * the shape this file uses to mean "no signing key is configured". Two different facts wearing one
 * value, and the wrong one would have been read on a deploy that HAS a key.
 *
 * Generalising costs nothing and moves nothing: at N = 8 this is the same `solidityPacked` call over
 * the same eight values, so every liquidation digest, signature and scheme string is byte-identical
 * to what it was. A bound is kept because `publicSignals` reaches here from a prover rather than from
 * a caller, and an unbounded pack is an unbounded allocation.
 */
const MAX_SIGNALS = 64;

export function signalsDigest(publicSignals) {
  if (!Array.isArray(publicSignals) || publicSignals.length === 0 || publicSignals.length > MAX_SIGNALS) return null;
  const n = publicSignals.length;
  return keccak256(solidityPacked(Array(n).fill('uint256'), publicSignals.map((s) => BigInt(s))));
}

/**
 * Attest to a set of public signals. Returns null when no key is configured — an absent signature is
 * honest, a fabricated one is not, and the contract is written to accept either (it reports what it
 * checked rather than pretending the check happened).
 */
export function attestSignals(publicSignals) {
  const s = signer();
  const digest = signalsDigest(publicSignals);
  if (!s || !digest) return null;
  try {
    return {
      // The count is the array's, not a literal. At eight signals this renders the exact string it
      // has always rendered, so a liquidation attestation is unchanged to the byte; at five or twelve
      // it describes the pack that was actually performed rather than one that was not.
      scheme: `secp256k1 (EIP-191 personal_sign over keccak256(abi.encodePacked(uint256[${publicSignals.length}] publicSignals)))`,
      signer: s.address,
      digest,
      signature: s.sk.sign(hashMessage(getBytes(digest))).serialized,
      verify: `ethers.verifyMessage(ethers.getBytes(digest), signature) === "${s.address}"`,
      onChain: 'QuiverProofRegistry.submit(proof, pubSignals, signature) recomputes this digest from calldata and recovers the signer',
    };
  } catch { return null; }
}

export const attestorAddress = () => signer()?.address || null;
