// GATE C — a value written in the wrong CASE must not change the ANSWER, on either surface.
//
// THE DEFECT THIS GATE OWNS. Direction was decided by comparing against a lowercase literal, and
// anything that did not match became the riskier default rather than a refusal:
//
//   src/engine/perpGate.js:29      (s === 'short' || s === 'sell' || s === -1 || s === '-1' ? -1 : 1)
//   src/engine/portfolioGate.js:30 (p.side === 'short' || p.side === 'sell' || size < 0) ? 'short' : 'long'
//   src/engine/optionsRisk.js:32   const type = p.type === 'put' ? 'put' : 'call'
//
// Measured before the fix, on both surfaces: `perp_gate {side:"SHORT"}` returned 91,139.24 — the LONG's
// liquidation price, telling a short seller they liquidate on the way DOWN. A perfectly hedged
// portfolio-gate book turned net exposure 0 into +200,000 the moment one leg said `"SHORT"`.
// `options_risk {type:"PUT"}` was priced as a call and flipped portfolio delta from −0.680134 to
// +0.319866. Every self-check passed in every one of those rows, because a self-check verifies the book
// the engine CHOSE, not the book the caller DESCRIBED — which is exactly what a silent substitution
// preserves. The result was signed, and `isChargeable()` billed for it.
//
// WHERE THE FIX LIVES, AND WHY IT IS NOT IN THE ENGINE. `src/util/repair.js` step 6 already
// case-corrected a value against a declared `enum`, and fired for none of these because none of the
// schemas declared one: `services.js` had `side: { type:'string', description:'long | short' }`. The fix
// is the enum arrays in `src/services.js` plus repair.js learning to descend into array items — three
// files, none of them under `src/engine/`, codeHash `q1-e1fa99d08887d6cc` unmoved.
//
// WHY BOTH SURFACES ARE SWEPT. `src/mcp.js` ALREADY advertised `side: { enum:['long','short'] }` to
// every MCP client and it did nothing, because `handleRpc` hands `repairBody` the SERVICES entry, never
// the TOOLS entry. An enum declared on one surface and enforced on neither is worse than no enum: a
// client that trusts the advertised schema is being told a constraint that is not applied. Test 6 below
// makes that structural rather than remembered.
//
// WHAT THIS GATE COULD NOT SEE, AND NOW DOES. Case was not the whole defect. `side: "banana"` was
// still served as long and `type: "banana"` still as a call, and test 7 used to assert exactly that
// pass-through so nobody could read this gate as a claim the whole class was closed. It is closed now,
// WITHOUT the engine change that limit assumed: repair.js still never coerces to a nearest neighbour,
// but a value matching no declared alternative is REFUSED before an engine is reached — at
// `s.validate` for the three HTTP call sites and explicitly in `handleRpc` for the fourth. Test 7 is
// now the opposite assertion. See hackathon/UNKNOWN_ENUM_REFUSAL.md and gates/gateU-unknown-enum.mjs,
// which owns the sweep; the single row here exists so that deleting the guard reddens THIS gate too.
//
//   node --test gates/gateC-case-sensitivity.mjs        (npm run gate:c)
//   node gates/gateC-revert.mjs                         (npm run gate:c-revert)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES } from '../src/services.js';
import { TOOLS, handleRpc } from '../src/mcp.js';
import { repairBody } from '../src/util/repair.js';
import { polyFill } from '../src/engine/polyFill.js';
import { GENUINE } from './routing-fixtures.mjs';

// ── discovery: the fields are found in the schemas, not listed here ───────────────────────────────
// A gate that hardcodes the fields it checks stops covering the service the day a field is added. The
// enum-carrying properties are read out of the live schema, top level and one array-item level deep,
// which is exactly the reach repair.js has.
function enumFields(schema, prefix = '', out = []) {
  for (const [k, spec] of Object.entries(schema?.properties || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(spec.enum)) out.push({ path, values: spec.enum });
    if (spec.type === 'array' && spec.items?.properties) enumFields(spec.items, `${path}[]`, out);
  }
  return out;
}

/** Every string field whose description enumerates alternatives with `|`. */
function pipeFields(schema, prefix = '', out = []) {
  for (const [k, spec] of Object.entries(schema?.properties || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (spec.type === 'string' && /\|/.test(spec.description || '') && !Array.isArray(spec.enum)) out.push(path);
    if (spec.type === 'array' && spec.items?.properties) pipeFields(spec.items, `${path}[]`, out);
  }
  return out;
}

const HTTP_ENUMS = new Map(SERVICES.map((s) => [s.name, enumFields(s.inputSchema)]));
const MCP_ENUMS = new Map(TOOLS.map((t) => [t.name.replace(/_/g, '-'), enumFields(t.inputSchema)]));

// ── the case variants a caller actually produces ──────────────────────────────────────────────────
const alternating = (v) => [...v].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');
const variantsOf = (v) => [...new Set([v.toUpperCase(), v.toLowerCase(), v[0].toUpperCase() + v.slice(1).toLowerCase(), alternating(v)])].filter((x) => x !== v);

// ── path plumbing for `positions[].side` ─────────────────────────────────────────────────────────
function setAt(body, path, value, index) {
  const clone = structuredClone(body);
  const m = path.match(/^(.+)\[\]\.(.+)$/);
  if (!m) { clone[path] = value; return clone; }
  const [, arr, key] = m;
  if (!Array.isArray(clone[arr]) || !clone[arr][index]) throw new Error(`fixture has no ${arr}[${index}] to drive`);
  clone[arr][index][key] = value;
  return clone;
}

// ── the bodies each field is driven on ───────────────────────────────────────────────────────────
// Written down rather than generated: every one is a call the service's own validate() accepts (test 8
// asserts that), and every value except the one under test is supplied, so nothing is fetched and the
// only thing that can move between two rows is the case of one word.
const DRIVE = {
  'perp-gate': { body: { side: 'long', venue: 'hyperliquid', entryPrice: 100000, size: 1, leverage: 10, maxLeverage: 40, markPrice: 100000 }, index: 0, endToEnd: true },
  'portfolio-gate': {
    body: {
      betaTier: 'severe',
      positions: [
        { venue: 'hyperliquid', asset: 'BTC', side: 'long', size: 1, entryPrice: 100000, markPrice: 100000, leverage: 10, maintMarginRate: 0.0125 },
        { venue: 'hyperliquid', asset: 'BTC', side: 'short', size: 1, entryPrice: 100000, markPrice: 100000, leverage: 10, maintMarginRate: 0.0125 },
      ],
    },
    index: 1,          // the SHORT leg — the one whose miscasing doubled the book
    endToEnd: true,
  },
  'options-risk': { body: { forward: 100000, positions: [{ type: 'put', strike: 110000, expiryDays: 30, iv: 0.6, quantity: 1 }] }, index: 0, endToEnd: true },
  // The three below have no MCP tool and reach the network when run, so they are swept on the input
  // identity (test 1/2) rather than on a served answer. poly-fill's engine takes an injectable book, so
  // its ANSWER is compared for real in test 4 — the one of the three that was returning the wrong side
  // of the market.
  'poly-fill': { body: { market: 'will-btc-hit-100k', usd: 500, action: 'sell' }, index: 0, endToEnd: false },
  'options-desk': { body: { currency: 'BTC', focus: 'all' }, index: 0, endToEnd: false },
  'chart-press': { body: { symbol: 'BTC-USDT', interval: '1H', theme: 'light', quality: 'full' }, index: 0, endToEnd: false },
};

// ── the sweep ────────────────────────────────────────────────────────────────────────────────────
const rows = [];
for (const s of SERVICES) {
  const fields = HTTP_ENUMS.get(s.name) || [];
  if (!fields.length) continue;
  const drive = DRIVE[s.name];
  if (!drive) { rows.push({ svc: s.name, field: '(all)', fatal: 'declares an enum and has no DRIVE body — unmeasured' }); continue; }
  const tool = TOOLS.find((t) => t.name === s.name.replace(/-/g, '_'));
  for (const { path, values } of fields) {
    for (const canonical of values) {
      const goodBody = setAt(drive.body, path, canonical, drive.index);
      const good = {
        repaired: repairBody(s, goodBody).body,
        validated: JSON.stringify(s.validate(repairBody(s, goodBody).body)),
      };
      for (const variant of variantsOf(canonical)) {
        const badBody = setAt(drive.body, path, variant, drive.index);
        const { body: repaired, repairs } = repairBody(s, badBody);
        rows.push({
          svc: s.name, field: path, canonical, variant, tool: tool?.name || null, endToEnd: drive.endToEnd,
          goodBody, badBody,
          httpSame: JSON.stringify(s.validate(repaired)) === good.validated,
          mcpSame: JSON.stringify(repaired) === JSON.stringify(good.repaired),
          reported: repairs.some((r) => r.kind === 'recased' && r.note.includes(variant)),
        });
      }
    }
  }
}

test('1. every miscased value reaches the PAID handler as the value the caller meant', () => {
  const bad = rows.filter((r) => r.fatal || !r.httpSame)
    .map((r) => r.fatal ? `${r.svc}: ${r.fatal}` : `${r.svc}.${r.field} "${r.variant}" !== "${r.canonical}"`);
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('2. and reaches the FREE MCP handler as the same value — repairBody is the only normaliser there', () => {
  // handleRpc never calls svc.validate(), so on the MCP surface the repaired body IS the input to the
  // engine. This is the assertion that would have caught an enum declared in mcp.js and nowhere else.
  const bad = rows.filter((r) => !r.fatal && !r.mcpSame).map((r) => `${r.svc}.${r.field} "${r.variant}" !== "${r.canonical}"`);
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('3. every normalisation is REPORTED to the caller, never silent', () => {
  // A silent coercion is how a caller ends up billed for an answer about a position they did not
  // describe — the failure this whole repair layer exists to avoid being.
  const silent = rows.filter((r) => !r.fatal && !r.reported).map((r) => `${r.svc}.${r.field} "${r.variant}"`);
  assert.deepEqual(silent, [], silent.join('\n  '));
});

test('4. the served ANSWER is identical, end to end, on the paid path and the free one', async () => {
  const offenders = [];
  const hashOf = (o) => o?.proof?.contentHash || o?.observation?.contentHash || null;
  for (const r of rows.filter((x) => x.endToEnd)) {
    const s = SERVICES.find((x) => x.name === r.svc);
    const good = await s.run(s.validate(repairBody(s, r.goodBody).body), { host: 'http://gate' });
    const bad = await s.run(s.validate(repairBody(s, r.badBody).body), { host: 'http://gate' });
    if (hashOf(good) == null) offenders.push(`${r.svc}: no contentHash — this row proved nothing`);
    else if (hashOf(good) !== hashOf(bad)) offenders.push(`http ${r.svc}.${r.field} "${r.variant}": ${hashOf(bad)?.slice(0, 16)} != ${hashOf(good)?.slice(0, 16)}`);

    if (!r.tool) continue;
    const call = async (body) => {
      const res = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: r.tool, arguments: body } });
      return JSON.parse(res.result.content[0].text);
    };
    const [mg, mb] = [await call(r.goodBody), await call(r.badBody)];
    if (hashOf(mg) !== hashOf(mb)) offenders.push(`mcp ${r.tool}.${r.field} "${r.variant}": ${hashOf(mb)?.slice(0, 16)} != ${hashOf(mg)?.slice(0, 16)}`);
  }

  // poly-fill has no MCP tool and reaches Polymarket when run, so its answer is compared at the engine
  // boundary against an injected book. Included because it is the one of the three network-bound
  // services that was returning the WRONG SIDE OF THE MARKET: measured pre-fix on a 40/60 book,
  // `action:"SELL"` was filled at 60c for 166.7 shares — the buy side — instead of 40c for 250.
  const deps = {
    resolveMarket: async () => ({ slug: 'm', question: 'q' }),
    clobTokenIds: () => ({ yes: 'y', no: 'n' }),
    book: async () => ({ timestamp: 1, asks: [{ price: 0.6, size: 10000 }], bids: [{ price: 0.4, size: 10000 }] }),
  };
  const svcPF = SERVICES.find((x) => x.name === 'poly-fill');
  for (const variant of variantsOf('sell')) {
    const good = await polyFill(svcPF.validate(repairBody(svcPF, { market: 'm', usd: 100, action: 'sell' }).body), deps);
    const bad = await polyFill(svcPF.validate(repairBody(svcPF, { market: 'm', usd: 100, action: variant }).body), deps);
    assert.ok(good.fill?.avgPriceCents, 'the stub book must actually fill, or this row proves nothing');
    if (JSON.stringify(good.fill) !== JSON.stringify(bad.fill)) {
      offenders.push(`poly-fill.action "${variant}": filled at ${bad.fill?.avgPriceCents}c vs ${good.fill?.avgPriceCents}c`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n  '));
});

test('4b. the exact rows the judge sweep measured now return the caller\'s own position', async () => {
  // Written as NUMBERS rather than as a comparison between two runs, and deliberately not derived from
  // the schema. Everything above discovers its fields by reading `inputSchema`, so deleting an enum
  // deletes the rows that would have failed — a revert could make those checks go quiet instead of red.
  // These three are the published table from hackathon/JUDGE_SWEEP_LIVE.md, hardcoded, and they fail
  // loudly whichever half of the fix is removed.
  const svc = (n) => SERVICES.find((s) => s.name === n);
  const viaMcp = async (tool, args) => {
    const res = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
    return JSON.parse(res.result.content[0].text);
  };
  const viaHttp = async (name, body) => { const s = svc(name); return s.run(s.validate(repairBody(s, body).body), { host: 'http://gate' }); };
  const bad = [];

  // 1. A short seller who capitalises one word was told they liquidate at 91,139.24 — BELOW their
  //    entry. They liquidate on the way up, at 108,641.98.
  for (const [surface, call] of [['http', (b) => viaHttp('perp-gate', b)], ['mcp', (b) => viaMcp('perp_gate', repairBody(svc('perp-gate'), b).body)]]) {
    for (const word of ['SHORT', 'Short', 'SELL']) {
      const r = await call({ side: word, entryPrice: 100000, size: 1, leverage: 10, maxLeverage: 40, markPrice: 100000 });
      if (r.liquidationPrice !== 108641.98) bad.push(`${surface} perp-gate side:"${word}" -> liquidationPrice ${r.liquidationPrice}, expected 108641.98 (the SHORT's)`);
      if (r.inputs?.side !== 'short') bad.push(`${surface} perp-gate side:"${word}" -> served as ${r.inputs?.side}`);
    }
  }

  // 2. A perfectly hedged book — one long, one short, same asset, size and price — read as a fully
  //    doubled-up directional bet the moment the second leg said "SHORT".
  const hedged = (word) => ({ positions: [
    { venue: 'hyperliquid', asset: 'BTC', side: 'long', size: 1, entryPrice: 100000, markPrice: 100000, leverage: 10, maintMarginRate: 0.0125 },
    { venue: 'hyperliquid', asset: 'BTC', side: word, size: 1, entryPrice: 100000, markPrice: 100000, leverage: 10, maintMarginRate: 0.0125 },
  ] });
  for (const [surface, call] of [['http', (b) => viaHttp('portfolio-gate', b)], ['mcp', (b) => viaMcp('portfolio_gate', repairBody(svc('portfolio-gate'), b).body)]]) {
    for (const word of ['SHORT', 'Short', 'SELL']) {
      const n = (await call(hedged(word))).netExposureByAsset?.[0];
      if (!(n?.netNotional === 0 && n?.longNotional === 100000 && n?.shortNotional === 100000)) {
        bad.push(`${surface} portfolio-gate leg side:"${word}" -> net ${n?.netNotional} long ${n?.longNotional} short ${n?.shortNotional}, expected 0 / 100000 / 100000`);
      }
    }
  }

  // 3. Every `type` that was not the literal "put" was priced as a call: delta +0.319866 handed to a
  //    caller hedging a put book, and the mark-to-model wrong by 10,000 on a single leg.
  const optBody = (word) => ({ forward: 100000, positions: [{ type: word, strike: 110000, expiryDays: 30, iv: 0.6, quantity: 1 }] });
  for (const [surface, call] of [['http', (b) => viaHttp('options-risk', b)], ['mcp', (b) => viaMcp('options_risk', repairBody(svc('options-risk'), b).body)]]) {
    for (const word of ['PUT', 'Put']) {
      const r = await call(optBody(word));
      if (r.greeks?.delta !== -0.680134) bad.push(`${surface} options-risk type:"${word}" -> delta ${r.greeks?.delta}, expected -0.680134`);
      // 13270.260505 at full served precision; the published tables round it to 13,270.26. The measured
      // value is the one asserted, because a gate that quotes a document rather than the wire is how a
      // rounding convention becomes a tolerance and a tolerance becomes a check that cannot fail.
      if (r.portfolioValue !== 13270.260505) bad.push(`${surface} options-risk type:"${word}" -> portfolioValue ${r.portfolioValue}, expected 13270.260505`);
      if (r.positions?.[0]?.type !== 'put') bad.push(`${surface} options-risk type:"${word}" -> priced as a ${r.positions?.[0]?.type}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('5. a body already in the right case is untouched, so no published contentHash moves', async () => {
  // The other half, and the one that would break every published proof if it went wrong. Every fixture
  // form of all twenty-two, plus the hashes recorded from the UNMODIFIED tree before the enums were
  // declared (captured 29 Jul 2026 from the Quiver mirror, which was byte-identical to this repository
  // apart from the four files the fix touches).
  const RECORDED = {
    'perp-gate#0': '33bbc8c26aab051cca65f17958b5dbdec6264571e0164288924a8bdec9901205',
    'size-gate#0': 'e7442ce6867cec43d89402211a9f3df6153d3efd4c43021ddf7dfadb2b60e902',
    'size-gate#1': 'ba489cc51f9f918fc9e3e1a9e02ea79c1334b4b1c455f0f249acb9ab2748012d',
    'exec-verify#0': '7be44a5186acc92502fcd975421c2a77e94d974c526da294cb5fd819fa497e25',
    'exec-verify#1': '9091b9533045e6498f00f6649d6f4df9653da7affa11df63ed91a585ae5ba5be',
    'options-risk#0': 'dce40b64b4476d2e9c44cfaa905b8432ac9b45296cfdd156c4471fecfe0aab2f',
    'lp-risk#0': 'e65cd458168072c2874335a9a3c177714f228a535e75ff947ccc12c3bd6277ba',
    'lp-risk#1': 'c3997db9b86ea5beaedf1d3af41e73d3013020221c73fb2d270c122625e2f332',
    'treasury-risk#0': '3d40bbc180e0d33f1d8bed2f60f968530c69bc9fd85da57c14bd0ffb0224ed08',
    'risk-attest#0': '3797719ae2e2ce0bb3caca169df267a8eb1b6cf2e345e4a939c0065b8ed554e0',
    'risk-attest#1': 'f349595f1e4a4c39e92a687b03a94375bf96f8e4dee5b82a8b64dc9dd993e82c',
    'event-vol#0': '8d653115a9c4e8752725a63288b283c5c10c25be2ee63b92b0e48f82ba09fd8a',
  };
  const moved = [];
  for (const s of SERVICES) {
    for (const [i, body] of (GENUINE[s.name] || []).entries()) {
      const { body: repaired, repairs } = repairBody(s, body);
      if (repairs.length || JSON.stringify(repaired) !== JSON.stringify(body)) {
        moved.push(`${s.name}#${i}: repair touched a correct body — ${repairs.map((r) => r.note).join('; ')}`);
      }
      const key = `${s.name}#${i}`;
      if (!(key in RECORDED)) continue;      // the rest reach the network; their input identity is checked above
      const out = await s.run(s.validate(repaired), { host: 'http://gate' });
      if (out?.proof?.contentHash !== RECORDED[key]) moved.push(`${key}: contentHash ${out?.proof?.contentHash?.slice(0, 16)} != recorded ${RECORDED[key].slice(0, 16)}`);
    }
  }
  // And the hedged portfolio book the defect was reported on, whose correct-case hash must also stand.
  const pg = SERVICES.find((s) => s.name === 'portfolio-gate');
  const hedged = await pg.run(pg.validate(repairBody(pg, DRIVE['portfolio-gate'].body).body), {});
  if (hedged?.proof?.contentHash !== '1b574b4e5985eb81bc625832513005b0ec452b1666dbcff47b9fe54da3305808') {
    moved.push(`portfolio-gate hedged+severe: ${hedged?.proof?.contentHash?.slice(0, 16)} != recorded 1b574b4e5985eb81`);
  }
  assert.deepEqual(moved, [], moved.join('\n  '));
});

test('6. an enum advertised on the MCP surface is also DECLARED on the one that enforces it', () => {
  // The structural fix for the failure that made this defect survive: mcp.js published
  // `side: enum ['long','short']` and repairBody was handed the SERVICES entry, so the constraint every
  // MCP client could read was never applied to anything. An enum in TOOLS with no twin in SERVICES is
  // decoration, and this is the check that says so.
  const drift = [];
  for (const [svcName, fields] of MCP_ENUMS) {
    const http = new Map((HTTP_ENUMS.get(svcName) || []).map((f) => [f.path, f.values]));
    for (const { path, values } of fields) {
      if (!http.has(path)) { drift.push(`mcp ${svcName}.${path} declares an enum that services.js does not — advertised, never enforced`); continue; }
      assert.deepEqual(http.get(path), values, `${svcName}.${path}: the two surfaces advertise different alternatives`);
    }
  }
  assert.deepEqual(drift, [], drift.join('\n  '));
});

test('7. a value matching NO declared alternative is REFUSED — not guessed at, and no longer served', async () => {
  // This assertion used to be its own opposite: `"banana"` was passed through by repair.js AND served
  // as a long, and the test recorded that as the deliberate limit of a fix that stayed out of
  // src/engine/. The limit was wrong about where the line had to be drawn. Refusing is not guessing,
  // and refusing happens at the VALIDATION layer, which is outside the hashed tree — so the class is
  // closed with `q1-e1fa99d08887d6cc` unmoved.
  //
  // Both halves are asserted, because they are different claims and only one of them changed:
  //   repair.js STILL passes the value through untouched — it will not coerce to a nearest neighbour;
  //   the SURFACES now refuse the request rather than serving an answer about the opposite position.
  const s = SERVICES.find((x) => x.name === 'perp-gate');
  for (const junk of ['banana', 's', 'lng', '']) {
    const sent = { ...DRIVE['perp-gate'].body, side: junk };
    const { body, repairs } = repairBody(s, sent);
    assert.equal(body.side, junk, `"${junk}" must still be passed through by repair exactly as written`);
    assert.deepEqual(repairs, [], `and nothing may be reported as repaired for "${junk}"`);

    const v = s.validate(body);
    assert.ok(v.error, `paid surface must refuse side:"${junk}" instead of serving it as a long`);
    assert.match(String(v.error), /"side"/, 'the refusal must name the field');
    assert.match(String(v.error), /"long", "short", "buy", "sell"/, 'and list the values that would work');

    const res = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'perp_gate', arguments: sent } });
    assert.equal(res.result.isError, true, `free MCP surface must refuse side:"${junk}" too — handleRpc never calls validate()`);
    const j = JSON.parse(res.result.content[0].text);
    assert.equal(j.ok, false, 'and refuse in the free-under-the-billing-contract shape');
    assert.equal(j.liquidationPrice, undefined, 'a refused request must not carry a liquidation price at all');
  }
});

test('8. this sweep actually reached what it claims to cover', () => {
  // Asserted before any number above is believed. The failure this repository keeps finding is a check
  // that swept an empty set and reported success over nothing.
  assert.equal(rows.filter((r) => r.fatal).length, 0, 'a service declaring an enum with no body to drive it is unmeasured');
  assert.ok(rows.length >= 60, `only ${rows.length} case variants were swept`);
  assert.ok(rows.filter((r) => r.endToEnd).length >= 20, 'too few rows were run end to end');
  assert.ok(rows.filter((r) => r.tool).length >= 15, 'the MCP surface was barely reached');

  // Every DRIVE body must be a call the service itself accepts, or the rows above measured a refusal.
  for (const [name, drive] of Object.entries(DRIVE)) {
    const s = SERVICES.find((x) => x.name === name);
    assert.ok(s, `${name} is not a service`);
    assert.equal(s.validate(drive.body).error, undefined, `${name}: the DRIVE body is not a call this service accepts`);
  }

  // The exact field set, as an equality. A new enum silently uncovered, or a covered one quietly
  // dropped, has to make somebody edit this list.
  const covered = [...new Set(rows.map((r) => `${r.svc}.${r.field}`))].sort();
  assert.deepEqual(covered, [
    'chart-press.quality', 'chart-press.theme',
    'options-desk.focus', 'options-risk.positions[].type',
    'perp-gate.side', 'perp-gate.venue',
    'poly-fill.action', 'portfolio-gate.betaTier', 'portfolio-gate.positions[].side',
  ], 'the set of case-corrected fields has changed');
});

test('9. every field still declared with a `|` description and no enum was decided, not missed', () => {
  // The sweep the brief asked for, kept alive. A string field whose description enumerates alternatives
  // is a candidate; the ones NOT given an enum are here with the reason, and the reason in every case is
  // that the value is already read through a case-folding consumer — so declaring an enum would recase
  // the echoed input and move a contentHash for a request that was already answered correctly.
  const DECIDED = {
    'tape-pulse.chain': 'services.js vToken lowercases before validate returns',
    'chart-press.chain': 'services.js vToken lowercases before validate returns',
    'chart-press.interval': 'okx-market.js:13 mapBar() lowercases',
    'chart-press.chartType': 'chartPress.js:43 lowercases before the CHART_TYPES lookup',
    'chart-press.format': 'chartPress.js:48 lowercases before comparing to svg',
    'poly-fill.side': 'polyFill.js:33 String(side).toUpperCase() — "no" already resolves to the NO book',
    'options-desk.currency': 'services.js validate uppercases and refuses anything outside BTC/ETH/SOL',
    'lp-desk.chain': 'services.js validate lowercases',
    'calldata-x.chain': 'services.js validate lowercases',
    'updown-pulse.coin': 'services.js validate uppercases and refuses anything outside BTC/ETH',
    'token-scan.chain': 'services.js vToken lowercases',
    'wallet-audit.chain': 'services.js vToken lowercases',
  };
  const found = [];
  for (const s of SERVICES) for (const p of pipeFields(s.inputSchema)) found.push(`${s.name}.${p}`);
  for (const t of TOOLS) for (const p of pipeFields(t.inputSchema)) found.push(`${t.name.replace(/_/g, '-')}.${p}`);
  const undecided = [...new Set(found)].filter((f) => !(f in DECIDED)).sort();
  assert.deepEqual(undecided, [], `these enumerate alternatives in prose, declare no enum, and nobody wrote down why:\n  ${undecided.join('\n  ')}`);
});
