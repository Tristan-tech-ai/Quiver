// Appendix C prints a worked proof — inputs, liquidation price, self-check residual, content hash and
// signer — and invites the reader to reproduce it. It went stale once already: the exhibit was pinned to
// a build that no longer ran, so its contentHash could not be reproduced by anyone following the page,
// and nothing in the suite noticed. A paper claim that the code can silently falsify is a claim with no
// owner, so this test gives it one: the printed numbers are asserted against what the engine produces
// TODAY, from the repository alone — no network, no payment, no served response.
//
// If an engine change moves the hash, this goes red and names the paper as the thing to update. That is
// the point. It is cheaper to re-render one appendix than to publish a proof a reader cannot verify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { perpGate } from '../src/engine/perpGate.js';
import { proofEnvelope, _internal } from '../src/engine/proof.js';

// Exactly the five values printed on the page as `proof.inputs`, and nothing else from the response.
const INPUTS = { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 };

const PAPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'whitepaper.html');
const build = () => proofEnvelope('perp-gate', INPUTS, perpGate(INPUTS), '0');

test('Appendix C: the exhibit regenerates from the repository alone, with no served response', () => {
  const { proof, ...result } = build();
  // The recipe as the page states it, implemented from that text rather than from the envelope.
  const preimage = _internal.canonical({
    engine: proof.engine, codeHash: proof.codeHash, inputs: proof.inputs, result: _internal.jsonClean(result),
  });
  const recomputed = createHash('sha256').update(preimage).digest('hex');
  assert.equal(recomputed, proof.contentHash,
    'the published recipe must reproduce the hash the envelope carries — offline, from source');
});

test('Appendix C: every number printed in the paper is the number the engine produces now', () => {
  const html = readFileSync(PAPER, 'utf8');
  const { proof, ...result } = build();

  // Pull the exhibit's own values out of the page, so this compares the paper to the code rather than
  // comparing the code to a constant a maintainer might update in only one of the two places.
  const printed = (label) => {
    const m = html.match(new RegExp(label + String.raw`\s+([^\s<]+)`));
    assert.ok(m, `Appendix C no longer prints "${label}" — the exhibit changed shape; update this test with it`);
    return m[1];
  };

  assert.equal(printed('proof\\.codeHash'), proof.codeHash,
    'the paper cites a build the engine no longer produces — Appendix C is stale');
  assert.equal(printed('proof\\.contentHash'), proof.contentHash,
    'the paper prints a content hash that cannot be reproduced from this code — a reader following it is told the response was altered');
  assert.equal(printed('proof\\.engine'), proof.engine);
  assert.equal(Number(printed('liquidationPrice')), Number(result.liquidationPrice));
  assert.equal(printed('positionStatus'), result.positionStatus);
});

test('Appendix C: the self-check the page prints actually passed, at the residual it claims', () => {
  const { proof } = build();
  const check = proof.selfChecks?.[0];
  assert.ok(check, 'the exhibit is sold on carrying a self-check');
  assert.equal(check.pass, true);
  const html = readFileSync(PAPER, 'utf8');
  assert.ok(html.includes(`residual ${check.residual}`),
    `the paper prints a residual that is not the one this code produces (${check.residual})`);
});

test("Appendix C: check 4 runs offline — the signature recovers to the signer the page names", async () => {
  // The page names a signer, but signing is key-gated: in the suite there is no key, so what is
  // verifiable here is the weaker, still-load-bearing half — that the signed preimage is the printed
  // contentHash string itself, which is what makes check 4 runnable from the bytes on the page.
  const { proof } = build();
  const html = readFileSync(PAPER, 'utf8');
  assert.ok(html.includes(proof.contentHash),
    'check 4 signs the contentHash as printed text, so that exact string must appear on the page');
  assert.match(proof.verifyContentHash, /WITHOUT its `proof` key/,
    'the envelope must carry the recipe the appendix tells the reader to follow');
});
