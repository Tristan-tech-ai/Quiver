# Reproducing & Verifying a Quiver Proof

Quiver's differentiator is that **correctness is re-derived, not trusted**. Every paid answer ships a `proof`
envelope; here is exactly how a third party checks it — no trust in Quiver required.

## What the proof contains
- `proof.codeHash` — sha256 of the open-source engine sources: the exact deterministic code that ran.
- `proof.inputs` — the exact inputs that produced the result (echoed, so "re-run" is self-contained).
- `proof.selfChecks` — each engine's ground-truth invariants (liquidation condition, martingale `E[S_T]=F`,
  arbitrage-free density, greek finite-differences, exposure reconciliation, …), each with pass/fail.
- `proof.contentHash` — sha256 over the canonical `{engine, codeHash, inputs, result}`.
- `proof.signature` (T1) — secp256k1 EIP-191 signature over `contentHash` by the published signer
  `0x946324E0E5d7D77206731E35Ef4044a383e2a8C2`.

## 1. Verify the code identity — rebuild → identical codeHash
The codeHash is a sha256 of the engine source files, so it is deterministic and rebuild-checkable:
```
git clone https://github.com/Tristan-tech-ai/Quiver && cd Quiver && npm ci
# codeHash = 'q1-' + sha256( for each src/engine/*.js sorted by name: `${filename}:${contents}` joined by "\n" ).slice(0,16)
```
Compare it against `GET /build` on the live server (which reports `codeHash` **and the Node version it runs on**)
and against `proof.codeHash` on any answer. All three must match.

## 2. Re-run the engine → identical result
Because the engines are deterministic, re-running the open engine on `proof.inputs` reproduces the result:
```js
import { perpGate } from './src/engine/perpGate.js';   // the engine named in proof.engine
const result = perpGate(proof.inputs);                  // === the served result
```
Basic IEEE-754 arithmetic is bit-identical across platforms; transcendentals (`exp/log/pow/erf`) are stable
**within a V8 version**. This was measured: `size-gate`'s `contentHash` is byte-identical on Windows and Linux
on the same Node major. For a bit-exact `contentHash` match, re-run on the **Node version reported at `/build`**.

## 3. Verify the signature (T1) and the batch attestation (EAS)
- `ethers.verifyMessage(proof.contentHash, proof.signature.signature) === proof.signature.signer` — must equal
  the published signer above.
- A batch of proofs can be Merkle-rooted via the `risk-attest` service, which additionally emits an **EIP-712
  typed, EAS-ready attestation** over the root (`easAttestation`): parseable named fields (`merkleRoot`,
  `itemCount`, `engineVersion`), verifiable with `ethers.verifyTypedData(...)`. Register the schema on the
  Ethereum Attestation Service (Base) and anchor it on-chain — that write is the operator's; Quiver holds no keys.

**The point:** you never have to trust that Quiver computed correctly. You rebuild the code, re-run the math,
and check the self-checks — and if any of them disagree, the proof fails *in your hands*, not on our word.
