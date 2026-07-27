// Three engines shipped sentences to paying callers that were not true, and one of them carried the
// word "verified". A false premise in a response is worse than a missing one: it is the failure the
// whole proof envelope exists to prevent, arriving through the one channel the envelope does not
// cover — the prose beside the number.
//
// These are source-level assertions on purpose. The defect IS the published string, so the artifact
// under test is the string, and a test that reads it can fail exactly when the string comes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine');
// Strip line comments before matching. The first version of this file read the raw source, and the
// code comment explaining WHY the old sentence was wrong quotes that sentence — so the test failed on
// its own documentation. A comment recording a correction is not the defect; the shipped string is.
const src = (f) => readFileSync(join(ENGINE, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('options-gex does not tell CALLERS that Deribit publishes no block-trade tag — it does', async () => {
  // Measured against the live public feed on 27 July 2026: `block_trade_id` and
  // `block_trade_leg_count` are present on BTC option trades (block-tagged trades were 48.9% of
  // contract volume in a 200-trade window) and `block_rfq_id` additionally on ETH (30.2%).
  //
  // Asserted on the ENGINE'S OUTPUT rather than its source, because the output is what a paying
  // caller receives and is the only thing a source check is a proxy for.
  const { computeGex } = await import('../src/engine/optionsGex.js');
  const book = [
    { strike: 60000, type: 'call', oi: 100, iv: 0.55, F: 64000, T: 0.08, r: 0 },
    { strike: 70000, type: 'call', oi: 80, iv: 0.60, F: 64000, T: 0.08, r: 0 },
    { strike: 60000, type: 'put', oi: 120, iv: 0.58, F: 64000, T: 0.08, r: 0 },
  ];
  const out = computeGex(book, 64000);
  assert.ok(out && out.assumption, 'the disclosure must actually be emitted');

  assert.doesNotMatch(out.assumption, /carries no block-trade tag/,
    'the feed does carry one; this claim was false and shipped with the word "verified"');
  assert.doesNotMatch(out.assumption, /\(verified\)/,
    '"verified" must not sit beside a premise nobody re-measured');
  assert.match(out.assumption, /block_trade_id/,
    'name the field that exists, so a reader can check it in one request');
  // The real reason the flow sign is not used must survive the correction, or the fix removes a
  // falsehood and takes the justification with it.
  assert.match(out.assumption, /attribution rather than tagging/i);
  assert.match(out.assumption, /Dealer positioning is ASSUMED/);
});

test('cross-market does not claim a local-vol model is REQUIRED for a smile-consistent barrier', () => {
  // The paper's own roadmap (§11.4 item 1) says the correction is "a closed-form overhedge from three
  // vanilla quotes already in the fitted smile". A service string calling local vol *required*
  // contradicts the document it ships beside.
  const s = src('crossMarket.js');
  assert.doesNotMatch(s, /requires a local-volatility model/,
    'the closed-form vanna-volga route exists and is committed in the roadmap');
  assert.match(s, /vanna-volga overhedge/,
    'the alternative the roadmap names must be named here too');
  // What is still true, and must not be lost: neither method runs inside this call today.
  assert.match(s, /neither runs inside this call/);
  assert.match(s, /model-uncertainty span|model uncertainty from that choice/);
});

test('lp-desk pins the window it replayed to a block range, not just a day count', () => {
  // `lp-desk` replays real on-chain swaps — the most reproducible input in the catalogue — and every
  // row it iterates already carried its block number. Reporting only days and a swap count made that
  // window impossible for anyone else to re-fetch.
  const s = src('lpDesk.js');
  assert.match(s, /firstBlock: rows\[0\]\.block/);
  assert.match(s, /lastBlock: rows\[rows\.length - 1\]\.block/);
});

test('the corrections did not quietly delete the disclosures they sat inside', () => {
  // Each of these strings existed to disclose a limit. A "fix" that removes the limitation along with
  // the false sentence would score well on this file and be a regression in the product.
  assert.match(src('optionsGex.js'), /not measured dealer inventory/);
  assert.match(src('crossMarket.js'), /disclosed approximation/);
});
