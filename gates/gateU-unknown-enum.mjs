// GATE U — a value matching NO declared alternative must be REFUSED, on both surfaces, and every value
// that does match must answer exactly as it did before the guard existed.
//
// THE DEFECT THIS GATE OWNS. Gate C closed miscasing: `side: "SHORT"` is repaired to `short` because
// `short` is a declared alternative. `side: "banana"` is not a case-variant of anything, so repair.js
// passed it through exactly as written — correctly, since coercing to a nearest neighbour would be
// inventing a value — and then three engines read anything unrecognised as the riskier default:
//
//   src/engine/perpGate.js:29      (s === 'short' || s === 'sell' || s === -1 || s === '-1' ? -1 : 1)
//   src/engine/portfolioGate.js:30 (p.side === 'short' || p.side === 'sell' || size < 0) ? 'short' : 'long'
//   src/engine/optionsRisk.js:32   const type = p.type === 'put' ? 'put' : 'call'
//
// Measured on this tree before the fix, on BOTH surfaces, for all 63 illegal-value rows: every one was
// SERVED. `perp_gate {side:"banana"}` returned 91,139.24 — the LONG's liquidation price — signed,
// self-checked, and billable. The hedged portfolio book became net +200,000 the moment one leg said
// anything the schema had not declared. `options_risk {type:"banana"}` was priced as a call.
//
// WHY REFUSING IS NOT GUESSING. Gate C's test 7 recorded the pass-through as the deliberate limit of a
// fix that stayed out of src/engine/, on the reasoning that closing it needed the ENGINES to refuse.
// That reasoning was wrong about where the line had to be drawn. Guessing invents a value the caller
// did not write; refusing invents nothing, and refusing happens at the VALIDATION layer, which is
// outside the hashed tree. `q1-e1fa99d08887d6cc` does not move.
//
// WHERE THE GUARD LIVES, AND WHY IT IS IN TWO PLACES. `enumViolations` in src/util/repair.js is the
// single implementation. Three of the four call sites that reach an engine go through `s.validate` —
// the paid `/api/*` route (app.js:548) and both gated diag testers (app.js:410, :425) — so the wrapper
// at the foot of src/services.js closes all three. The FOURTH, `handleRpc` in src/mcp.js, never calls
// `validate()` at all: after repairBody the repaired body IS the engine input. A guard written only in
// services.js would have left the FREE surface — the one a builder and a judge try first — still
// answering `side:"banana"` as a long. Tests 3 and 4 below are that surface, asserted separately.
//
// THE HALF THAT MATTERS MOST is test 1: a refusal that fires on correct input is worse than the bug it
// fixes. Every declared value of every declared enum, in every case a caller might write it, on both
// surfaces, against content hashes recorded from the tree BEFORE the guard existed.
//
//   node --test gates/gateU-unknown-enum.mjs        (npm run gate:u)
//   node gates/gateU-revert.mjs                     (npm run gate:u-revert)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES } from '../src/services.js';
import { TOOLS, handleRpc } from '../src/mcp.js';
import { repairBody, enumViolations, enumRefusal } from '../src/util/repair.js';
import { isChargeable } from '../src/x402.js';

// ── discovery: fields are READ from the live schemas, never listed here ───────────────────────────
// Top level plus one array-item level, which is exactly the reach repair.js and the guard both have.
function enumFields(schema, prefix = '', out = []) {
  for (const [k, spec] of Object.entries(schema?.properties || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(spec.enum)) out.push({ path, values: spec.enum });
    if (spec.type === 'array' && spec.items?.properties) enumFields(spec.items, `${path}[]`, out);
  }
  return out;
}
/** Every string field that enumerates alternatives in PROSE and declares no enum. */
function pipeFields(schema, prefix = '', out = []) {
  for (const [k, spec] of Object.entries(schema?.properties || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (spec.type === 'string' && /\|/.test(spec.description || '') && !Array.isArray(spec.enum)) out.push(path);
    if (spec.type === 'array' && spec.items?.properties) pipeFields(spec.items, `${path}[]`, out);
  }
  return out;
}
function setAt(body, path, value, index) {
  const clone = structuredClone(body);
  const m = path.match(/^(.+)\[\]\.(.+)$/);
  if (!m) { clone[path] = value; return clone; }
  const [, arr, key] = m;
  if (!Array.isArray(clone[arr]) || !clone[arr][index]) throw new Error(`fixture has no ${arr}[${index}] to drive`);
  clone[arr][index][key] = value;
  return clone;
}
const alternating = (v) => [...v].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');
const casings = (v) => [...new Set([v, v.toUpperCase(), v.toLowerCase(), v[0].toUpperCase() + v.slice(1).toLowerCase(), alternating(v)])];

// ── the bodies each field is driven on ───────────────────────────────────────────────────────────
// The same six as gate C, so the two gates measure the same requests, and every value except the one
// under test is supplied so nothing is fetched and only one word can move between rows.
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
    index: 1, endToEnd: true,
  },
  'options-risk': { body: { forward: 100000, positions: [{ type: 'put', strike: 110000, expiryDays: 30, iv: 0.6, quantity: 1 }] }, index: 0, endToEnd: true },
  // These three reach the network when run, so they are measured on the object the engine would be
  // handed (the input identity) rather than on a served answer.
  'poly-fill': { body: { market: 'will-btc-hit-100k', usd: 500, action: 'sell' }, index: 0, endToEnd: false },
  'options-desk': { body: { currency: 'BTC', focus: 'all' }, index: 0, endToEnd: false },
  'chart-press': { body: { symbol: 'BTC-USDT', interval: '1H', theme: 'light', quality: 'full' }, index: 0, endToEnd: false },
};

// Values no service declares. Chosen to cover the shapes a caller really produces: a typo, a
// truncation, a doubled letter, a trailing space, the empty string, and the WORD "null" (which is not
// null, and which a stringifying framework emits).
const ILLEGAL = ['banana', 'lng', 'p', 'SHORTT', '', 'long ', 'null'];

const svc = (n) => SERVICES.find((s) => s.name === n);
const toolFor = (n) => TOOLS.find((t) => t.name === n.replace(/-/g, '_'));
const hashOf = (o) => o?.proof?.contentHash || o?.observation?.contentHash || null;
const viaMcp = async (tool, args) => {
  const res = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
  return { isError: res.result.isError === true, json: JSON.parse(res.result.content[0].text) };
};

test('1. EVERY declared value, in every casing, on both surfaces, answers exactly as it did before the guard', async () => {
  // Recorded from the PRE-GUARD tree (the Quiver mirror, 29 Jul 2026, byte-identical to this repository
  // apart from the three files this change touches). Hardcoded rather than compared between two runs of
  // this tree, so that deleting an enum makes this go RED instead of going quiet — the failure mode gate
  // C's test 4b was written to avoid, applied to the other direction.
  const RECORDED = {
    'perp-gate venue=hyperliquid': '7468bf90395431ba67befc85727b20c0bfd334e4be94db92201462aa249f5222',
    'perp-gate venue=dydx': '4a8b85b00852ff064843f1e661030ee2ce9c5cdf8efb6ddccecf469535e586b2',
    'perp-gate side=long': '7468bf90395431ba67befc85727b20c0bfd334e4be94db92201462aa249f5222',
    'perp-gate side=short': '218f016e694508d69bd6c138a939f42d11ffeee96a7d8b0b4140589d53a1384d',
    'perp-gate side=buy': '96adf7e2de2e4025776b4c79f86a7590da476f3a13cab6f082898245df69b82e',
    'perp-gate side=sell': 'be3fb5fbccf4eaa93ddc7610e8953960347c65ba1c80f227cd3f866bea3c7c0e',
    // `-1` was NOT a declared alternative before this change and IS one now, for a measured reason:
    // perpGate.js:29 honours the string, the mirror serves it as a short at 108,641.98, and this is the
    // hash it produced there. Omitting it from the enum would have turned a request that answers
    // CORRECTLY today into a refusal, which is the failure this gate's test 1 exists to prevent.
    'perp-gate side=-1': 'ca717a01b637a9137bcd619b961867ccc479b156f2057297ac9e7daa2fc8b98b',
    'portfolio-gate positions[].side=long': '48a55ce125c812693354a29bdcd6ef6d7e1b67ec6d6b96613c5aef04cbfa636b',
    'portfolio-gate positions[].side=short': '1b574b4e5985eb81bc625832513005b0ec452b1666dbcff47b9fe54da3305808',
    'portfolio-gate positions[].side=buy': '10f2a1145dfc26f11ba52fbd2dc89e9b853c866bf5e1a8367048bf972c916240',
    'portfolio-gate positions[].side=sell': '9d036d988b6fe509526011cbd33ba0fd73ab97f10c8d3e64fa4e4cf8a532abea',
    'portfolio-gate betaTier=mild': '4a58064607b83303442847f33f3c05914addf332df66c7179af283bca62b7ba7',
    'portfolio-gate betaTier=moderate': 'b28cb4ebee7bfd5d76222ba94b472b90c20127afdba65be1f102916d9d8302a7',
    'portfolio-gate betaTier=severe': '1b574b4e5985eb81bc625832513005b0ec452b1666dbcff47b9fe54da3305808',
    'options-risk positions[].type=call': '874b15ccda637bac8b4fa7bf752eb40ba342ba051d197137286d8c91ee4f0a1e',
    'options-risk positions[].type=put': '2b55bbf8287ebb842b7619b3deae20ceb1cba8c37093a69999985368482b1217',
  };
  const broken = [];
  let swept = 0, verifiedAgainstRecord = 0;

  for (const s of SERVICES) {
    const fields = enumFields(s.inputSchema);
    if (!fields.length) continue;
    const drive = DRIVE[s.name];
    if (!drive) { broken.push(`${s.name}: declares an enum with no DRIVE body — unmeasured`); continue; }
    const tool = toolFor(s.name);

    for (const { path, values } of fields) {
      for (const legal of values) {
        const key = `${s.name} ${path}=${legal}`;
        for (const written of casings(legal)) {
          swept++;
          const sent = setAt(drive.body, path, written, drive.index);
          const { body: repaired } = repairBody(s, sent);

          // THE ASSERTION THAT MATTERS. A declared value — however the caller capitalised it — must
          // never be refused. This is the half a careless guard breaks.
          const v = s.validate(repaired);
          if (v.error) { broken.push(`${key} written "${written}": REFUSED a declared value — ${String(v.error).slice(0, 90)}`); continue; }
          if (enumViolations(s, repaired).length) { broken.push(`${key} written "${written}": the guard flagged a declared value`); continue; }

          if (drive.endToEnd) {
            const out = await s.run(v, { host: 'http://gate' });
            if (!hashOf(out)) { broken.push(`${key}: no contentHash — this row proved nothing`); continue; }
            if (key in RECORDED) {
              verifiedAgainstRecord++;
              if (hashOf(out) !== RECORDED[key]) broken.push(`${key} written "${written}": contentHash ${hashOf(out).slice(0, 16)} != recorded ${RECORDED[key].slice(0, 16)}`);
            }
          }
          if (tool) {
            const { isError, json } = await viaMcp(tool.name, sent);
            if (isError) { broken.push(`${key} written "${written}": the FREE surface refused a declared value`); continue; }
            if (key in RECORDED && hashOf(json) !== RECORDED[key]) {
              broken.push(`mcp ${key} written "${written}": contentHash ${hashOf(json)?.slice(0, 16)} != recorded ${RECORDED[key].slice(0, 16)}`);
            }
          }
        }
      }
    }
  }
  // A sweep that reached nothing reports success over nothing. Asserted before the result is believed.
  assert.ok(swept >= 90, `only ${swept} legal-value rows were swept`);
  assert.ok(verifiedAgainstRecord >= 60, `only ${verifiedAgainstRecord} rows were checked against a hash recorded from the pre-guard tree`);
  assert.deepEqual(broken, [], broken.join('\n  '));
});

test('2. an unrecognised value is REFUSED on the paid surface, naming the field and what would work', () => {
  const bad = [];
  let rows = 0;
  for (const s of SERVICES) {
    for (const { path, values } of enumFields(s.inputSchema)) {
      const drive = DRIVE[s.name];
      for (const junk of ILLEGAL) {
        rows++;
        const sent = setAt(drive.body, path, junk, drive.index);
        const { body: repaired } = repairBody(s, sent);
        const v = s.validate(repaired);
        const where = `${s.name}.${path} = ${JSON.stringify(junk)}`;
        if (!v.error) { bad.push(`${where}: SERVED, not refused`); continue; }
        const msg = String(v.error);
        // Naming the field is the difference between a refusal a caller can act on and one they cannot.
        const leaf = path.replace('[]', `[${drive.index}]`);
        if (!msg.includes(`"${leaf}"`)) bad.push(`${where}: the refusal does not name the field (${msg.slice(0, 80)})`);
        for (const legal of values) if (!msg.includes(`"${legal}"`)) bad.push(`${where}: the refusal omits the legal value "${legal}"`);
        if (!msg.includes(JSON.stringify(junk))) bad.push(`${where}: the refusal does not quote back what was sent`);
      }
    }
  }
  assert.ok(rows >= 60, `only ${rows} illegal-value rows were driven`);
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('3. and on the FREE MCP surface, which never calls validate() — the site a services.js-only fix misses', async () => {
  // The whole reason this gate has two refusal tests instead of one. handleRpc hands repairBody the
  // SERVICES entry and then goes straight to the engine; nothing in mcp.js consulted `svc.validate`.
  const bad = [];
  let rows = 0;
  for (const s of SERVICES) {
    const tool = toolFor(s.name);
    if (!tool) continue;
    for (const { path, values } of enumFields(s.inputSchema)) {
      for (const junk of ILLEGAL) {
        rows++;
        const sent = setAt(DRIVE[s.name].body, path, junk, DRIVE[s.name].index);
        const { isError, json } = await viaMcp(tool.name, sent);
        const where = `mcp ${tool.name}.${path} = ${JSON.stringify(junk)}`;
        if (!isError) { bad.push(`${where}: SERVED, not refused`); continue; }
        if (json.ok !== false) bad.push(`${where}: refused without ok:false — the billing contract reads that field`);
        const msg = JSON.stringify(json.errors);
        const leaf = path.replace('[]', `[${DRIVE[s.name].index}]`);
        if (!msg.includes(`\\"${leaf}\\"`)) bad.push(`${where}: the refusal does not name the field (${msg.slice(0, 90)})`);
        for (const legal of values) if (!msg.includes(legal)) bad.push(`${where}: the refusal omits the legal value "${legal}"`);
        // And it must hand back something sendable, not just a complaint.
        if (!json.howToFix?.send?.body) bad.push(`${where}: refused without a corrected body`);
      }
    }
  }
  assert.ok(rows >= 25, `only ${rows} illegal-value rows reached the MCP surface`);
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('4. the published rows, as hardcoded numbers: the wrong answer is GONE, not merely different', async () => {
  // Deliberately not derived from the schema. Everything above discovers its fields by reading
  // `inputSchema`, so deleting an enum deletes the rows that would have failed. These are the three
  // numbers the pre-fix sweep measured being served for a value no service declares.
  const bad = [];
  for (const [surface, call] of [
    ['http', async (b) => { const s = svc('perp-gate'); const v = s.validate(repairBody(s, b).body); return v.error ? { refused: v.error } : s.run(v, { host: 'http://gate' }); }],
    ['mcp', async (b) => (await viaMcp('perp_gate', b)).json],
  ]) {
    const r = await call({ side: 'banana', entryPrice: 100000, size: 1, leverage: 10, maxLeverage: 40, markPrice: 100000 });
    if (r.liquidationPrice === 91139.24) bad.push(`${surface} perp-gate side:"banana" -> still served 91139.24, the LONG's liquidation price`);
    if (!(r.refused || r.ok === false)) bad.push(`${surface} perp-gate side:"banana" -> answered instead of refusing`);
  }
  const hedged = (word) => ({ positions: [
    { venue: 'hyperliquid', asset: 'BTC', side: 'long', size: 1, entryPrice: 100000, markPrice: 100000, leverage: 10, maintMarginRate: 0.0125 },
    { venue: 'hyperliquid', asset: 'BTC', side: word, size: 1, entryPrice: 100000, markPrice: 100000, leverage: 10, maintMarginRate: 0.0125 },
  ] });
  for (const [surface, call] of [
    ['http', async (b) => { const s = svc('portfolio-gate'); const v = s.validate(repairBody(s, b).body); return v.error ? { refused: v.error } : s.run(v, { host: 'http://gate' }); }],
    ['mcp', async (b) => (await viaMcp('portfolio_gate', b)).json],
  ]) {
    const r = await call(hedged('banana'));
    const n = r.netExposureByAsset?.[0];
    if (n?.netNotional === 200000) bad.push(`${surface} portfolio-gate leg side:"banana" -> still doubled the hedged book to net 200000`);
    if (!(r.refused || r.ok === false)) bad.push(`${surface} portfolio-gate leg side:"banana" -> answered instead of refusing`);
  }
  const optBody = (word) => ({ forward: 100000, positions: [{ type: word, strike: 110000, expiryDays: 30, iv: 0.6, quantity: 1 }] });
  for (const [surface, call] of [
    ['http', async (b) => { const s = svc('options-risk'); const v = s.validate(repairBody(s, b).body); return v.error ? { refused: v.error } : s.run(v, { host: 'http://gate' }); }],
    ['mcp', async (b) => (await viaMcp('options_risk', b)).json],
  ]) {
    const r = await call(optBody('banana'));
    if (r.greeks?.delta === 0.319866) bad.push(`${surface} options-risk type:"banana" -> still priced as a CALL, delta +0.319866`);
    if (!(r.refused || r.ok === false)) bad.push(`${surface} options-risk type:"banana" -> answered instead of refusing`);
  }

  // THE OTHER DIRECTION, and the one a careless guard breaks. `side:"-1"` is honoured by
  // perpGate.js:29 and answers 108,641.98 — the SHORT's price, which is CORRECT. Asserted as a
  // hardcoded number rather than discovered from the enum, because a guard that dropped "-1" from the
  // declared set would delete the row that should have failed and go quiet instead of red. This is the
  // row that says "refusing correct input is worse than the bug" out loud.
  for (const [surface, call] of [
    ['http', async (b) => { const s = svc('perp-gate'); const v = s.validate(repairBody(s, b).body); return v.error ? { refused: v.error } : s.run(v, { host: 'http://gate' }); }],
    ['mcp', async (b) => (await viaMcp('perp_gate', b)).json],
  ]) {
    const r = await call({ side: '-1', venue: 'hyperliquid', entryPrice: 100000, size: 1, leverage: 10, maxLeverage: 40, markPrice: 100000 });
    if (r.refused || r.ok === false) bad.push(`${surface} perp-gate side:"-1" -> REFUSED a value the engine honours and answers correctly (${String(r.refused || r.errors).slice(0, 80)})`);
    if (r.liquidationPrice !== 108641.98) bad.push(`${surface} perp-gate side:"-1" -> liquidationPrice ${r.liquidationPrice}, expected 108641.98 (the SHORT's)`);
    if (hashOf(r) !== 'ca717a01b637a9137bcd619b961867ccc479b156f2057297ac9e7daa2fc8b98b') bad.push(`${surface} perp-gate side:"-1" -> contentHash moved to ${hashOf(r)?.slice(0, 16)}`);
  }
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('5. the guard is the exact COMPLEMENT of repair.js, not a second opinion about the same value', () => {
  // If the guard were stricter than the repairer, a value repair.js considers legal could still be
  // refused — the two halves of one contract disagreeing. Both compare case-insensitively against the
  // same declared set, so: repaired => never flagged, and flagged => repair had nothing to offer.
  const disagreements = [];
  for (const s of SERVICES) {
    for (const { path, values } of enumFields(s.inputSchema)) {
      const drive = DRIVE[s.name];
      for (const legal of values) {
        for (const written of casings(legal)) {
          const { body: repaired } = repairBody(s, setAt(drive.body, path, written, drive.index));
          const flagged = enumViolations(s, repaired);
          if (flagged.length) disagreements.push(`${s.name}.${path}: repair accepted "${written}" and the guard refused it`);
        }
      }
      for (const junk of ILLEGAL) {
        const sent = setAt(drive.body, path, junk, drive.index);
        const { body: repaired, repairs } = repairBody(s, sent);
        if (repairs.length) disagreements.push(`${s.name}.${path}: repair claims to have fixed "${junk}" — it must never coerce to a nearest neighbour`);
        if (!enumViolations(s, repaired).length) disagreements.push(`${s.name}.${path}: the guard passed "${junk}", which matches nothing declared`);
      }
    }
  }
  assert.deepEqual(disagreements, [], disagreements.join('\n  '));
});

test('6. a refusal is FREE — on both surfaces, and by the same rule the billing contract already reads', async () => {
  // `isChargeable` is what x402.js:269 consults to skip /settle. The MCP refusal carries ok:false, so
  // it is free by that rule directly; the paid refusal is thrown with status 400 from inside the
  // handler, which x402.js returns at line 255-264 — BEFORE /settle is ever called. The wire proof of
  // the second (status 400, billed:false, PAYMENT-RESPONSE) lives in gates/gateP-paid-teaching.mjs;
  // what is asserted here is that no refusal shape this guard produces is ever chargeable.
  const { json } = await viaMcp('perp_gate', { side: 'banana', entryPrice: 100000, size: 1, leverage: 10, maxLeverage: 40, markPrice: 100000 });
  assert.equal(json.ok, false);
  assert.equal(isChargeable(json), false, 'a caller must not pay to be told their own value is not one this service declares');

  // …and the paid path refuses at VALIDATE, which is strictly before `run`. That ordering is what makes
  // it free: nothing is computed, so there is no delivered answer to settle against.
  const s = svc('perp-gate');
  const v = s.validate(repairBody(s, { side: 'banana', entryPrice: 100000, size: 1, leverage: 10, maxLeverage: 40, markPrice: 100000 }).body);
  assert.ok(v.error, 'the refusal must come from validate(), not from the engine');
  assert.equal(isChargeable({ ok: false, errors: [v.error] }), false);
});

test('7. a field with no declared enum is NEVER caught — the free-form set, re-derived not inherited', () => {
  // The other way to break this: a guard that fires on a field whose value is genuinely open. Every
  // string field that enumerates alternatives in PROSE and declares no enum is re-derived from the live
  // schemas here (not copied from gate C's list) and driven with the same junk. The guard must be silent
  // on every one, because it acts on a declared `enum` and nothing else.
  const caught = [];
  const covered = [];
  const PROBE = { 'poly-fill': { market: 'm', usd: 100 }, 'options-desk': { currency: 'BTC' }, 'updown-pulse': { coin: 'BTC' } };
  for (const s of [...SERVICES, ...TOOLS.map((t) => ({ name: t.name.replace(/_/g, '-'), inputSchema: t.inputSchema }))]) {
    for (const path of pipeFields(s.inputSchema)) {
      covered.push(`${s.name}.${path}`);
      const base = PROBE[s.name] || {};
      for (const junk of ILLEGAL) {
        const body = path.includes('[]') ? base : { ...base, [path]: junk };
        const hits = enumViolations(s, body).filter((v) => v.path === path);
        if (hits.length) caught.push(`${s.name}.${path}: the guard fired on a field with no declared enum`);
      }
    }
  }
  assert.deepEqual(caught, [], caught.join('\n  '));
  // And the set itself is asserted, so a new prose-enumerated field cannot be quietly added on either
  // surface without somebody deciding whether it should be guarded.
  //
  // RE-DERIVED, AND IT CAME BACK ELEVEN, NOT TWELVE. gate C test 9's DECIDED map carries a twelfth
  // entry — `chart-press.chain` — that the live schema never produces: its description reads "DEX chain
  // (with address); OR omit and pass symbol for a CEX pair" and contains no `|`, so it was never a
  // prose-enumerated field. That map is filtered one way (found ⊆ DECIDED), so a stale key passes
  // silently there. This list is an EQUALITY in both directions, which is why the discrepancy showed up
  // the first time it ran. Eleven is the number CASE_SENSITIVITY_FIX.md §3 states, and eleven is what
  // the schemas actually contain.
  assert.deepEqual([...new Set(covered)].sort(), [
    'calldata-x.chain', 'chart-press.chartType', 'chart-press.format', 'chart-press.interval',
    'lp-desk.chain', 'options-desk.currency', 'poly-fill.side', 'tape-pulse.chain', 'token-scan.chain',
    'updown-pulse.coin', 'wallet-audit.chain',
  ], 'the set of prose-enumerated, unguarded fields has changed');
  assert.equal([...new Set(covered)].length, 11, 'eleven free-form candidates, re-derived from the live schemas');
});

test('8. the sweep reached what it claims to cover, and the guarded set is an EQUALITY', () => {
  const covered = [];
  for (const s of SERVICES) for (const f of enumFields(s.inputSchema)) covered.push(`${s.name}.${f.path}`);
  assert.deepEqual([...new Set(covered)].sort(), [
    'chart-press.quality', 'chart-press.theme',
    'options-desk.focus', 'options-risk.positions[].type',
    'perp-gate.side', 'perp-gate.venue',
    'poly-fill.action', 'portfolio-gate.betaTier', 'portfolio-gate.positions[].side',
  ], 'the set of guarded fields has changed — a new enum is covered for free, a deleted one must be noticed');

  // Every DRIVE body must be a call the service itself accepts, or every row above measured a refusal
  // that was already there.
  for (const [name, drive] of Object.entries(DRIVE)) {
    const s = svc(name);
    assert.ok(s, `${name} is not a service`);
    assert.equal(s.validate(drive.body).error, undefined, `${name}: the DRIVE body is not a call this service accepts`);
  }
  // The message builder is the shared one. If the two surfaces ever built their own, this is the check
  // that says so — same violations in, same sentence out.
  const s = svc('perp-gate');
  const violations = enumViolations(s, { side: 'banana' });
  assert.equal(violations.length, 1);
  assert.match(enumRefusal(violations), /"side".*"long", "short", "buy", "sell", "-1"/);
});
