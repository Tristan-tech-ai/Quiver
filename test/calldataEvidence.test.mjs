// calldata-x evidence bundle (strategy opening #3). buildEvidenceBundle did not exist pre-fix → these
// FAIL on the old code. Verifies: each asset/approval effect becomes a re-checkable assertion; the base
// block pins the state; absence of a pinnable block is disclosed (never silently dropped).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceBundle } from '../src/engine/calldataX.js';

const CALL = { from: '0xfrom', to: '0xUSDC', data: '0x095ea7b3abcdef', value: '0' };
const SIM = {
  blockNumber: 25577620,
  assetChanges: [{ token: '0xdai', symbol: 'DAI', direction: 'OUT', amount: '1000.0' }],
  approvalChanges: [{ token: '0xUSDC', symbol: 'USDC', spender: '0xPermit2', amount: 'UNLIMITED' }],
};
const BASE = { number: 25577619, hash: '0x' + 'a'.repeat(64) };

test('evidence bundle: every effect becomes a re-checkable assertion', () => {
  const eb = buildEvidenceBundle(CALL, SIM, BASE);
  assert.equal(eb.assertionCount, 2);
  const asset = eb.assertions.find((a) => a.kind === 'asset-delta');
  assert.ok(asset.claim.includes('sends 1000.0 DAI OUT'));
  const appr = eb.assertions.find((a) => a.kind === 'approval');
  assert.ok(appr.claim.includes('0xPermit2') && appr.claim.includes('UNLIMITED'));
});

test('evidence bundle: base block pins the state and reCheck cites the hash', () => {
  const eb = buildEvidenceBundle(CALL, SIM, BASE);
  assert.equal(eb.pinnedState.baseBlockNumber, 25577619);
  assert.equal(eb.pinnedState.baseBlockHash, BASE.hash);
  assert.ok(eb.reCheck.includes(BASE.hash), 'reCheck must cite the pinned hash so it is reproducible');
  assert.ok(eb.reCheck.includes('re-orged'), 'must handle the re-org case honestly');
  assert.equal(eb.method, 'eth_simulateV1');
});

test('evidence bundle: unpinnable base block is DISCLOSED, not silently dropped', () => {
  const eb = buildEvidenceBundle(CALL, SIM, null);
  assert.ok(eb.pinnedState.note.includes('unavailable'));
  assert.ok(!eb.pinnedState.baseBlockHash);
  assert.ok(eb.reCheck.includes('not pinnable'), 'reCheck must say the base was not pinned');
  assert.equal(eb.assertionCount, 2, 'assertions still emitted even without a pin');
});

test('evidence bundle: no effects → zero assertions (a clean, honest empty)', () => {
  const eb = buildEvidenceBundle(CALL, { blockNumber: 1, assetChanges: [], approvalChanges: [] }, BASE);
  assert.equal(eb.assertionCount, 0);
  assert.deepEqual(eb.assertions, []);
});
