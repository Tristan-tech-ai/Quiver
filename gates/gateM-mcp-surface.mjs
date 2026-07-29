// GATE M — every MCP tool, called the way a caller would actually call it.
//
// WHAT IT IS FOR. The free `/mcp` surface is the one a builder tries first and the one a judge tries
// first, and it had a live ReferenceError sitting on the headline feature of its most expensive tool:
// `portfolio_gate {account:"0x…"}` answered `error: fetchHlAccount is not defined`, because
// src/mcp.js called the function and never imported it. The HTTP path imported it correctly, so every
// test, every doc sweep and the whole `src/engine` hash were green while the advertised feature was
// dead on the surface most people meet.
//
// WHY NOTHING CAUGHT IT. Preflight already called every MCP tool. It called all nine with the SAME
// body — `{ params: {} }` — and asserted only that the handler did not throw at the transport layer.
// An empty argument set never reaches the `/^0x…{40}$/` branch, so the broken line was never
// executed, and a tool answering `isError: true` counted as a tool that "survived". The check was
// real and its coverage was one shape wide. This gate is the missing half: a body per tool that
// exercises the path the tool's own description advertises, and a hard failure on `isError` — the
// signal preflight was throwing away.
//
// The same rule applied to the paid surface catches the other two: `poly-fill` on a market that does
// not exist and `tape-pulse` on a chain/address mismatch both returned HTTP 500 `engine_error` on a
// CALLER's mistake, the second pasting OKX's own `{"code":"51000",...}` string into the answer.
//
// WHAT IT ASSERTS
//   1. Every tool in `tools/list` has a fixture here. A tool with no fixture is an unmeasured tool
//      reading as a passing one, so the set is asserted as an EQUALITY against the live list.
//   2. No tool answers `isError`, and none returns an `error:` text — that string is what a thrown
//      ReferenceError looks like once handleRpc has caught it.
//   3. No answer contains a raw upstream error string. A caller must never be handed
//      `okx GET /api/v6/... -> 400 {"code":"51000"}` as their answer.
//   4. Every HTTP service refuses a caller's mistake as a REFUSAL — `ok:false` with a `howToFix`
//      carrying a sendable body — and never as a 500 and never by echoing the upstream verbatim.
//   5. `account` mode specifically returns a usable book, because that is the defect that shipped and
//      a check written after a defect must fail on that defect and not merely near it.
//
// NETWORK. Tools 1, 2 and 5 read live venues; that is the point, since the defect lived in the venue
// adapter call. A network failure is reported as a network failure rather than passed over.
//
//   node --test gates/gateM-mcp-surface.mjs        (npm run gate:m)
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRpc, TOOLS } from '../src/mcp.js';
import { byName } from '../src/services.js';

// A body per tool that a caller would really send — the ADVERTISED path, not the cheapest one that
// parses. Where a tool has two modes and one of them is the one in its description, that is the mode
// used: portfolio_gate's `account` is the headline the description sells ("OR just account: a
// Hyperliquid 0x address, whose FULL live book … is pulled keylessly"), and it is the mode that was
// broken. A live account with open positions, because an empty book is a different code path.
const LIVE_HL_ACCOUNT = '0x31ca8395cf837de08b24da3f660e77761dfb974b';

const FIXTURES = {
  perp_gate: [
    { label: 'explicit inputs', args: { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 } },
    { label: 'symbol mode (live venue read)', args: { symbol: 'BTC', notional: 60000, leverage: 10 } },
  ],
  portfolio_gate: [
    { label: 'explicit legs', args: { positions: [{ venue: 'hyperliquid', asset: 'BTC', side: 'long', size: 1, entryPrice: 60000, leverage: 10, maxLeverage: 40 }] } },
    // THE DEFECT. Kept first-class rather than folded into a loop, because this exact call is the one
    // that answered `error: fetchHlAccount is not defined` on the live service.
    { label: 'account mode — the advertised headline', args: { account: LIVE_HL_ACCOUNT }, expectPositions: true },
  ],
  size_gate: [
    { label: 'discrete edge', args: { winProb: 0.55, winLossRatio: 1.2, bankroll: 10000 } },
    { label: 'continuous edge', args: { expectedReturn: 0.02, volatility: 0.1, bankroll: 10000 } },
  ],
  exec_verify: [
    { label: 'constant-product', args: { amountIn: 1000, amountOutRealized: 990, reserveIn: 500000, reserveOut: 500000, feeTier: 0.003 } },
    { label: 'reference price', args: { amountIn: 1000, amountOutRealized: 990, fairPrice: 1.0 } },
  ],
  options_risk: [
    { label: 'one call leg', args: { forward: 60000, positions: [{ type: 'call', strike: 62000, iv: 0.6, quantity: 1, expiryDays: 30 }] } },
  ],
  lp_risk: [
    { label: 'realized IL', args: { priceRatio: 1.4, feeAprPct: 20 } },
  ],
  treasury_risk: [
    { label: 'one holding', args: { positions: [{ asset: 'USDC', amountUsd: 1000000, apyPct: 4.5 }] } },
  ],
  risk_attest: [
    { label: 'two content hashes', args: { contentHashes: ['a'.repeat(64), 'b'.repeat(64)] } },
  ],
  event_vol: [
    { label: 'FOMC in 7 days', args: { spot: 60000, atmIvPct: 55, daysToEvent: 7 } },
  ],
};

// Strings that must never reach a caller as an answer. Each one is a real leak this project has
// shipped or nearly shipped, not a guess at what a leak looks like.
const UPSTREAM_LEAKS = [
  /okx (GET|POST) \/api\/v\d/i,          // the OKX REST adapter's thrown message
  /"code"\s*:\s*"5\d{4}"/,               // an OKX error code object, verbatim
  /is not defined/,                       // a ReferenceError that reached the wire
  /is not a function/,                    // its sibling
  /\bat .+\.js:\d+:\d+/,                  // a stack frame
];

const callTool = async (name, args) => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const text = r?.result?.content?.[0]?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* an unparseable body is itself reported below */ }
  return { rpc: r, isError: r?.result?.isError === true, text, parsed };
};

test('every tool the server advertises has a realistic fixture here', async () => {
  const listed = (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name).sort();
  const covered = Object.keys(FIXTURES).sort();
  // EQUALITY, not containment. A tool added to the server without a fixture would otherwise be a
  // silent hole in exactly the surface this gate exists to cover.
  assert.deepEqual(covered, listed,
    `the fixture set and the advertised tool list must be the same set — missing [${listed.filter((n) => !covered.includes(n))}], stale [${covered.filter((n) => !listed.includes(n))}]`);
  assert.equal(listed.length, TOOLS.length);
});

for (const [tool, cases] of Object.entries(FIXTURES)) {
  for (const c of cases) {
    test(`${tool} — ${c.label} — answers without an error`, async () => {
      const { rpc, isError, text, parsed } = await callTool(tool, c.args);

      assert.ok(rpc?.result, `${tool} returned no result: ${JSON.stringify(rpc?.error)}`);
      // The assertion preflight was missing. `isError` is set by handleRpc for both a thrown
      // exception and an engine `ok:false`, and on a body the tool advertises it must be neither.
      assert.equal(isError, false,
        `${tool} answered isError on a body its own description advertises:\n    ${text.slice(0, 300)}`);
      assert.ok(parsed, `${tool} returned a body that is not JSON: ${text.slice(0, 200)}`);
      assert.notEqual(parsed.ok, false, `${tool} refused a realistic call: ${JSON.stringify(parsed.errors)}`);

      // A caught throw surfaces as `content[0].text === "error: <message>"` with no JSON at all. That
      // is the exact shape `fetchHlAccount is not defined` arrived in.
      assert.ok(!/^error: /.test(text), `${tool} surfaced a thrown error as its answer: ${text.slice(0, 200)}`);
      for (const leak of UPSTREAM_LEAKS) {
        assert.ok(!leak.test(text), `${tool} leaked an upstream/internal string matching ${leak}:\n    ${text.slice(0, 300)}`);
      }

      // An answer must carry the verifiability envelope the listing promises.
      const env = parsed.proof || parsed.observation;
      assert.ok(env?.contentHash, `${tool} answered without a proof or observation envelope`);

      if (c.expectPositions) {
        assert.ok(Number(parsed.positionsCount) > 0,
          `${tool} account mode returned no positions — the live book was not read`);
        assert.ok(Array.isArray(parsed.netExposureByAsset) && parsed.netExposureByAsset.length > 0,
          `${tool} account mode returned no net exposure`);
      }
    });
  }
}

// ── the paid surface: a caller's mistake is a refusal, never a fault ─────────────────────────────
//
// Same rule, other surface. These two bodies both returned HTTP 500 `engine_error` on the live
// service; the tape-pulse one pasted OKX's parameter rejection into the response.
const MISTAKES = [
  {
    service: 'poly-fill',
    label: 'a market slug that names nothing live',
    body: { market: 'will-elon-musk-buy-mars-by-2027', usd: 1000 },
    says: /no active Polymarket market matched/,
  },
  {
    service: 'tape-pulse',
    label: 'a Solana chain with an EVM address',
    body: { chain: 'solana', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
    says: /cannot exist|EVM address/,
  },
  {
    service: 'tape-pulse',
    label: 'an EVM chain with a Solana mint',
    body: { chain: 'ethereum', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    says: /cannot exist|base58/,
  },
];

for (const m of MISTAKES) {
  test(`${m.service} — ${m.label} — refuses, and never faults`, async () => {
    const s = byName[m.service];
    const v = s.validate(m.body);
    assert.ok(!v.error || typeof v.error === 'string', 'validate must return a verdict, not throw');

    let out;
    if (v.error) {
      // A schema refusal is already the right answer; it is the 500 path this gate is about.
      out = { ok: false, errors: [v.error] };
    } else {
      // MUST NOT THROW. A throw here is precisely the 500: app.js and x402.js both turn an
      // uncaught engine error into `engine_error`, which reports a caller's typo as a server fault.
      out = await s.run(v, { host: 'http://gate' });
    }

    assert.equal(out.ok, false, `${m.service} answered a body it cannot serve instead of refusing it`);
    assert.match(JSON.stringify(out.errors), m.says, 'the refusal must name what is actually wrong');
    // `ok:false` is what x402.isChargeable() reads to skip settlement, so this is also the assertion
    // that the caller is not billed for their own typo.
    assert.ok(out.howToFix?.send?.body, `${m.service} refused without a sendable corrected body`);
    assert.equal(out.howToFix.send.url, s.path);

    for (const leak of UPSTREAM_LEAKS) {
      // `upstreamDetail` is a deliberate, labelled field for the backstop path; the LEAK test is
      // about the parts a caller reads as the answer, so it is excluded by name rather than by
      // loosening the pattern.
      const { upstreamDetail, ...visible } = out;
      assert.ok(!leak.test(JSON.stringify(visible)),
        `${m.service} refusal leaked an upstream string matching ${leak}:\n    ${JSON.stringify(visible).slice(0, 300)}`);
    }
  });
}
