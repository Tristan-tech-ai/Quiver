// The endpoint URL is what a submission, a registry entry and a marketplace listing all point at, so
// `/` is the first thing both kinds of reader touch — and they want opposite things. An agent needs
// the machine service index. A person needs to learn, in one glance, whether this is a finished
// product. Serving JSON to both meant the human learned nothing; serving HTML to both would break
// every automated consumer, which is the more expensive mistake of the two.
//
// These fail against the previous handler, which answered JSON unconditionally.
import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';

async function get(path, headers = {}) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers });
    return { status: res.status, type: res.headers.get('content-type') || '', body: await res.text() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('an agent still gets the machine index — this is the contract that must not move', async () => {
  const r = await get('/', { accept: 'application/json' });
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  const j = JSON.parse(r.body);
  assert.equal(j.name, 'Quiver');
  assert.ok(Object.keys(j.services).length >= 20, 'the service index must still enumerate the catalogue');
  assert.ok(j.payment && j.identity, 'payment and identity are what a discovering agent reads');
});

test('curl and anything sending */* gets JSON, not a web page', async () => {
  // The default matters: `res.format` resolves */* to its FIRST key, and a scripted consumer that
  // suddenly receives HTML fails in a way that is tedious to diagnose.
  for (const accept of ['*/*', undefined]) {
    const r = await get('/', accept ? { accept } : {});
    assert.match(r.type, /application\/json/, `Accept: ${accept ?? '(none)'} must resolve to JSON`);
  }
});

test('a browser gets a page that explains the product without being asked', async () => {
  const r = await get('/', { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' });
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.body, /<title>/i);
  // The page exists to make one claim checkable in the first screenful, so assert on that rather
  // than on it merely being HTML — "renders something" is not the requirement.
  assert.match(r.body, /re-derives the result instead of believing it/,
    'the differentiating claim must be on the page, not only in the paper');
  assert.match(r.body, /\/build/, 'the ten-second check must be present');
  assert.match(r.body, /402 Payment Required/, 'the payment surface must be inspectable from here');
  assert.match(r.body, /ERC-8004 agent #5152/);
  for (let i = 1; i <= 6; i++) assert.ok(r.body.includes(`/paper/${i}`), `the machine edition part ${i} must be linked`);
});

test('the index never points at a route that does not exist', async () => {
  // `/paper/human` was removed when /paper went back to being the typeset edition, and the index
  // kept advertising it for a while. A discovery document that names a 404 is worse than one that
  // names nothing.
  const j = JSON.parse((await get('/', { accept: 'application/json' })).body);
  const advertised = [j.docs, j.build, j.agentCard, ...(j.docsMachineReadable || [])].filter(Boolean);
  for (const path of advertised) {
    const r = await get(path, { accept: 'application/json,text/html' });
    assert.notEqual(r.status, 404, `${path} is advertised by the index but answers 404`);
  }
});
