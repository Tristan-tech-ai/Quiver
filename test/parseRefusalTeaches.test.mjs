// Table 9 of the paper said the 400 `note` is self-teaching — that it names what was missing, then
// repeats the service description and every alternative required-field group. Measured against the
// live service, that was true of the SCHEMA-failure path and false of the PARSE-failure path, which
// returned only "that was not JSON". The row described one path and claimed both.
//
// Rather than weaken the claim, the parse path now carries the same hint: the route is known even
// when the body is not. These tests FAIL on the pre-fix handler, which had no service lookup at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';

async function post(path, body, headers = { 'Content-Type': 'application/json' }) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('an unparseable body on a known route names the service and what it needs', async () => {
  const { status, body } = await post('/api/perp-gate', '{not json');
  assert.equal(status, 400);
  assert.equal(body.error, 'bad_input');
  assert.match(body.note, /perp-gate/, 'the note must name the service the caller was trying to reach');
  assert.match(body.note, /requires|accepts|EITHER|OR/i, 'and the input shape it would have needed');
  assert.ok(body.note.length > 160, 'a hint this short is the old generic sentence, not a teaching one');
});

test('the parser position is still disclosed, because the caller cannot derive it', async () => {
  const { body } = await post('/api/perp-gate', '{not json');
  assert.match(body.parserDetail, /position/i);
});

// Guards. A handler that pasted the same text onto everything would pass the tests above.
test('an unknown route gets the generic note, with no service invented for it', async () => {
  const { status, body } = await post('/api/no-such-service', '{not json');
  assert.equal(status, 400);
  assert.match(body.note, /not valid JSON/);
  assert.doesNotMatch(body.note, /requires \{/, 'there is no service here, so there is no shape to teach');
});

// The x402 contract: the payment gate must still be what answers a WELL-FORMED unpaid request. The
// parse handler running earlier must not have turned a 402 route into a 400 one.
test('a well-formed unpaid request still gets the 402 challenge, not a 400', async () => {
  const { status } = await post('/api/perp-gate', JSON.stringify({ side: 'long', entryPrice: 64000, size: 1, leverage: 10 }));
  assert.equal(status, 402, 'payment precedence is unchanged by teaching the parse refusal');
});
