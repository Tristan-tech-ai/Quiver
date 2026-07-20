// proof.js — the T0 verifiability envelope. The differentiator, done honestly.
//
// The market urgently wants provable agent outputs (two-thirds of finance decision-makers want a liability
// framework). LLM-based risk tools cannot cheaply prove correctness — ZK-proving inference is 10,000-100,000x
// too slow. Quiver's compute is DETERMINISTIC math, so the proof is nearly free and, crucially, is about
// CORRECTNESS, not just consistency:
//   • Re-runnability  — inputs are echoed and the engine is open source; anyone re-runs it and gets the
//     identical result. This is the actual verification (a signature only proves "Quiver said it", not
//     "it is right"). RiskState ships SHA-256 policy hashes too — signing is table stakes; re-running to a
//     mathematical answer is not.
//   • Self-checks     — each engine tests its own output against a GROUND-TRUTH INVARIANT (liquidation
//     condition, Kelly FOC, constant-product k, martingale E[S_T]=F, arb-free minG>=0). A wrong number
//     fails its own check; the envelope carries the pass/fail so a caller never has to trust us.
//   • Content hash    — sha256 over the canonical {engine, codeHash, inputs, result} makes the envelope
//     tamper-evident and content-addressable.
//
// NOT fabricated: there is no secret-key "signature" here — that (secp256k1 by a Quiver key) and on-chain
// attestation are the T1/T2 upgrades, added only when a key is configured. Shipping a fake signature would
// violate the whole premise. What ships is real: reproduce + self-check + content hash.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SigningKey, computeAddress, hashMessage, TypedDataEncoder, verifyTypedData } from 'ethers';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// T1 signer — secp256k1 over the content hash, SYNCHRONOUS (ethers SigningKey.sign), so the envelope stays
// synchronous and nothing downstream needs to await. Active ONLY when QUIVER_SIGNING_KEY is set in the env;
// the key is never in code, never logged, never returned — only the resulting signature + signer address.
// undefined = not yet checked, null = no key configured, object = { sk, address }.
let SIGNER;
function signer() {
  if (SIGNER !== undefined) return SIGNER;
  const raw = process.env.QUIVER_SIGNING_KEY;
  if (!raw) { SIGNER = null; return null; }
  // Normalize common paste errors: trim, then strip ALL leading 0x/0X prefixes. A 64-hex private key can
  // never contain an 'x', so stripping "0x" prefixes is unambiguous and safe — it recovers a key pasted with
  // a double prefix ("0x0x…", a frequent mistake) without ever transforming valid key material. Then require
  // exactly 64 hex characters; anything else stays T0 (a malformed credential must not silently "work").
  let k = String(raw).trim();
  while (/^0x/i.test(k)) k = k.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(k)) { SIGNER = null; return null; }
  try {
    const sk = new SigningKey('0x' + k);
    SIGNER = { sk, address: computeAddress(sk.publicKey) };
  } catch { SIGNER = null; }
  return SIGNER;
}

// Stable, key-sorted serialization so the content hash is reproducible across runs/machines.
function canonical(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o) ?? 'null';
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}

// BUILD_ID — hash of all engine sources, computed once. Identifies the exact deterministic code that ran,
// so "re-run the engine on these inputs" is unambiguous.
let BUILD_ID = null;
function buildId() {
  if (BUILD_ID) return BUILD_ID;
  try {
    const dir = dirname(fileURLToPath(import.meta.url)); // src/engine
    const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
    const concat = files.map((f) => `${f}:${readFileSync(join(dir, f), 'utf8')}`).join('\n');
    BUILD_ID = 'q1-' + sha256(concat).slice(0, 16);
  } catch { BUILD_ID = 'unknown'; }
  return BUILD_ID;
}

/**
 * Wrap a deterministic engine result in a T0 proof envelope.
 * @param engine  service/engine name (e.g. 'perp-gate')
 * @param inputs  the validated inputs that produced the result (echoed for reproducibility)
 * @param result  the engine's return value (expected to carry a `checks` array of self-checks)
 * @param version build/version string
 */
export function proofEnvelope(engine, inputs, result, version = '0') {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  const allChecksPass = checks.length === 0 ? null : checks.every((c) => c.pass !== false);
  const codeHash = buildId();
  const contentHash = sha256(canonical({ engine, codeHash, inputs, result }));

  // T1: sign the content hash if a key is configured. Absent a key we ship honest T0 (no fake signature).
  const s = signer();
  let signature = null;
  if (s) {
    try {
      signature = {
        scheme: 'secp256k1 (EIP-191 personal_sign over contentHash)',
        signer: s.address,
        signature: s.sk.sign(hashMessage(contentHash)).serialized,
        verify: `ethers.verifyMessage(contentHash, signature) === "${s.address}"`,
      };
    } catch { signature = null; }
  }

  return {
    ...result,
    proof: {
      engine,
      version,
      codeHash,
      deterministic: true,
      inputs, // the EXACT inputs that were hashed — echoed so "reproduce" is self-contained, not a bare claim
      selfChecks: checks,
      allSelfChecksPass: allChecksPass,
      reproduce: `Deterministic: re-run the open-source '${engine}' engine (build ${codeHash}) on proof.inputs to reproduce this result exactly. Verify contentHash to detect tampering. No trust in Quiver required.`,
      contentHash,
      ...(signature ? { signature } : {}),
      attestation: signature
        ? 'T1 (re-runnable + self-checked + content-hashed + secp256k1-signed). On-chain anchor of contentHash is the T2 upgrade.'
        : 'T0 (re-runnable + self-checked + content-hashed). T1 secp256k1 signature / on-chain anchor available when QUIVER_SIGNING_KEY is configured.',
    },
  };
}

// EIP-712 typed-data signature by the SAME Quiver signer — for EAS-ready, human/contract-parseable
// attestations (named fields) as opposed to the opaque EIP-191 hash signature. Deterministic (RFC-6979), so
// the same typed value yields the same signature. Returns null when no signing key is configured (T0).
export function signEip712(domain, types, value) {
  const s = signer();
  if (!s) return null;
  try {
    const digest = TypedDataEncoder.hash(domain, types, value);
    return { signature: s.sk.sign(digest).serialized, signer: s.address };
  } catch { return null; }
}
export function verifyEip712(domain, types, value, signature) {
  try { return verifyTypedData(domain, types, value, signature); } catch { return null; }
}

export const _internal = { canonical, buildId, sha256, signerAddress: () => signer()?.address || null };
