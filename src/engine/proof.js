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

// Hash what the wire carries, not what memory holds. res.json DROPS undefined-valued keys, turns Dates
// into ISO strings and NaN/Infinity into null — so a consumer recomputing the hash from the response they
// RECEIVED would false-fail against a hash taken over the raw in-memory object (caught by test: an object
// with an undefined field verified in memory but not on the wire). One JSON round-trip makes the committed
// form and the received form identical by construction.
function jsonClean(x) { return x === undefined ? null : JSON.parse(JSON.stringify(x)); }

// The recipe used to say only "recompute from the response you received", for both envelope kinds.
// For an observation that is exactly right — a live venue read cannot be re-derived from source. For
// a deterministic proof it under-sold the guarantee: `inputs` is echoed in the envelope and the engine
// is public, so `result` can be REGENERATED rather than merely received, and the whole exhibit
// reproduces offline from the repository with no response and no payment. That was measured against
// Appendix C before this text was changed. Tamper-evidence and re-runnability are different claims,
// and only one of them survives without the server; saying so is the difference between "trust this
// response" and "you do not need this response".
const hashRecipe = (envelopeKey, fields, regenerable) =>
  `Recompute from the response you received: contentHash = sha256(canonical({${fields}})) where result = this response WITHOUT its \`${envelopeKey}\` key, the other fields are echoed inside \`${envelopeKey}\`, and canonical(x) = recursive key-sorted JSON ('{"a":1,"b":[2]}' form). A mismatch means the response was altered.`
  + (regenerable
    ? ` You do not need this response to do it: the engine is open source and \`${envelopeKey}.inputs\` is echoed above, so re-running the published engine on those inputs regenerates \`result\` and therefore this exact hash. The repository alone is sufficient — offline, unpaid, and without contacting the service.`
    : ` This hash cannot be regenerated from source, because it commits a live upstream read at observedAtUtc that no re-run reproduces — see \`semantics\`. Recomputing it detects tampering; it does not re-derive the number.`);

// BUILD_ID — hash of all engine sources, computed once. Identifies the exact deterministic code that ran,
// so "re-run the engine on these inputs" is unambiguous.
let BUILD_ID = null;

// The file list the build hash is taken over. This used to be a NON-RECURSIVE readdir, which is why
// it is now a named, exported function rather than one line inside buildId: `src/engine/chart/`
// holds the ECharts renderer and the indicator library — 42 kB of engine source that chartPress.js
// imports — and none of it was hashed. So that code could change while the published codeHash stayed
// identical, in a service whose every envelope carries the string "one hash over ALL engine sources".
// The claim was the defect, not the arithmetic. Walking the tree makes the claim true; keys are the
// path RELATIVE to src/engine, so a top-level file's key is unchanged and only the previously
// invisible files move the hash.
export function engineSourceFiles(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...engineSourceFiles(join(dir, e.name), rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out.sort();
}

function buildId() {
  if (BUILD_ID) return BUILD_ID;
  try {
    const dir = dirname(fileURLToPath(import.meta.url)); // src/engine
    const files = engineSourceFiles(dir);
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
  // A deterministic proof promises that re-running the engine on `inputs` reproduces this result
  // byte-for-byte. A live-provenance block is by definition NOT a function of `inputs`, so sealing one
  // inside the content hash makes that promise unkeepable — and the envelope then tells the caller
  // that a mismatch means tampering, so the instruction at the centre of this service accuses an
  // honest answer. That defect was found and fixed at three call sites on three separate occasions;
  // the fourth was the free MCP path. Fixing call sites one at a time has not worked, so the rule is
  // enforced here instead: a result carrying live provenance is not a proof, and is routed to the
  // envelope that can carry it honestly rather than sealed in one that cannot.
  if (result && typeof result === 'object' && !Array.isArray(result) && result.live !== undefined) {
    return observationEnvelope(engine, inputs, result, version);
  }
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  // Tri-state on purpose. The old form was `every(c => c.pass !== false)`, which read an explicitly
  // SKIPPED check (`pass: null`) as a passing one — so a response where nothing was checked at all
  // published `allSelfChecksPass: true`. exec-verify's reference mode refuses to report an un-run
  // check as a pass, in those words, and this line then reinstated the guarantee its own comment had
  // declined to make. A consumer gating on this field could not tell "every invariant held" from "no
  // invariant was asserted". Now: false if any check failed, true only if every check explicitly
  // passed, null when nothing conclusive was run.
  const allChecksPass = checks.length === 0 ? null
    : checks.some((c) => c.pass === false) ? false
    : checks.every((c) => c.pass === true) ? true
    : null;
  const codeHash = buildId();
  const cleanInputs = jsonClean(inputs);
  const contentHash = sha256(canonical({ engine, codeHash, inputs: cleanInputs, result: jsonClean(result) }));

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
      codeHashScope: 'build — one hash over ALL engine sources, shared by every service in this deploy (the specific engine name is committed separately in this envelope)',
      deterministic: true,
      inputs: cleanInputs, // the EXACT inputs that were hashed — echoed so "reproduce" is self-contained, not a bare claim
      selfChecks: checks,
      allSelfChecksPass: allChecksPass,
      reproduce: `Deterministic: re-run the open-source '${engine}' engine (build ${codeHash}) on proof.inputs to reproduce this result exactly. Verify contentHash to detect tampering. No trust in Quiver required.`,
      contentHash,
      verifyContentHash: hashRecipe('proof', 'engine, codeHash, inputs, result', true),
      ...(signature ? { signature } : {}),
      // "self-checked" is claimed only when a check actually ran and passed. Printing it beside a
      // response whose every check was skipped is the same overstatement allSelfChecksPass used to make.
      attestation: (signature
        ? `T1 (re-runnable + ${allChecksPass === true ? 'self-checked + ' : ''}content-hashed + secp256k1-signed).`
        : `T0 (re-runnable + ${allChecksPass === true ? 'self-checked + ' : ''}content-hashed).`)
        + (allChecksPass === null ? ' NOTE: no self-check was asserted on this call — see selfChecks for which were skipped and why.' : '')
        + (signature
          ? ' On-chain anchor of contentHash is the T2 upgrade.'
          : ' T1 secp256k1 signature / on-chain anchor available when QUIVER_SIGNING_KEY is configured.'),
    },
  };
}

/**
 * Wrap a LIVE-market result in an OBSERVATION envelope — the honest sibling of proofEnvelope.
 * Deterministic engines get `proof` (re-run and you MUST reproduce it). Live-data services cannot make
 * that claim — markets move — and pretending otherwise is exactly the "sign everything, imply
 * reproducibility" costume this stack refuses. What a live answer CAN commit to: this is what Quiver
 * observed and served at observedAtUtc, tamper-evident via contentHash, attributable via the T1
 * signature when a key is configured, and anchorable on-chain (EAS) to timestamp the claim.
 */
export function observationEnvelope(engine, inputs, result, version = '0') {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result; // envelope JSON objects only
  const checks = Array.isArray(result.checks) ? result.checks : [];
  // Tri-state on purpose. The old form was `every(c => c.pass !== false)`, which read an explicitly
  // SKIPPED check (`pass: null`) as a passing one — so a response where nothing was checked at all
  // published `allSelfChecksPass: true`. exec-verify's reference mode refuses to report an un-run
  // check as a pass, in those words, and this line then reinstated the guarantee its own comment had
  // declined to make. A consumer gating on this field could not tell "every invariant held" from "no
  // invariant was asserted". Now: false if any check failed, true only if every check explicitly
  // passed, null when nothing conclusive was run.
  const allChecksPass = checks.length === 0 ? null
    : checks.some((c) => c.pass === false) ? false
    : checks.every((c) => c.pass === true) ? true
    : null;
  const codeHash = buildId();
  const observedAtUtc = new Date().toISOString();
  const cleanInputs = jsonClean(inputs);
  const contentHash = sha256(canonical({ engine, codeHash, observedAtUtc, inputs: cleanInputs, result: jsonClean(result) }));

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
    observation: {
      engine,
      version,
      codeHash,
      codeHashScope: 'build — one hash over ALL engine sources, shared by every service in this deploy (the specific engine name is committed separately in this envelope)',
      kind: 'OBSERVATION',
      deterministic: false,
      observedAtUtc,
      inputs: cleanInputs,
      selfChecks: checks,
      allSelfChecksPass: allChecksPass,
      contentHash,
      verifyContentHash: hashRecipe('observation', 'engine, codeHash, observedAtUtc, inputs, result', false),
      ...(signature ? { signature } : {}),
      semantics: `A COMMITTED OBSERVATION of live upstreams at observedAtUtc — NOT re-runnable to the identical result, because the market has moved since (that claim is reserved for deterministic Quiver services, which ship a 'proof' envelope instead; the distinction is deliberate). Tamper-evident: recompute contentHash per verifyContentHash. ${signature ? 'Attributable: the secp256k1 signature binds this hash to the Quiver signer.' : 'A secp256k1 signature is added when QUIVER_SIGNING_KEY is configured.'} Anchor contentHash on-chain (e.g. an EAS attestation) to timestamp what was served.`,
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

export const _internal = { canonical, buildId, sha256, jsonClean, signerAddress: () => signer()?.address || null };
