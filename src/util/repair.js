// What buyers actually get wrong, and what to do about each kind.
//
// The two half-star reviews on agent #5152 came from a caller that could not find the right service.
// That is one failure mode out of several, and the others are cheaper to fix. An agent assembling a
// call from a service listing gets a small, repeatable set of things wrong:
//
//   WRAPPED     the params sit under `input` / `params` / `arguments`, because that is the shape the
//               caller's own framework hands around
//   STRINGIFIED numbers arrive as strings, because they came out of a JSON blob a model wrote
//   MISCASED    `Currency` instead of `currency`, or `BTC` where the enum wants `btc`
//   ALIASED     `token` for `address`, `symbol` for `currency` — a synonym a human would accept
//   PROSE       one free-text field and no structured params at all
//   EMPTY       nothing, because the marketplace funnel dropped the body in transit
//   MIS-ROUTED  a perfectly good request aimed at the wrong service (see routing.js)
//
// THE LINE THIS FILE DOES NOT CROSS. Repairing a SHAPE is not the same as inventing a VALUE. Unwrapping
// `{params:{...}}`, reading "64000" as 64000, or matching `Currency` to `currency` all recover what the
// caller plainly meant; none of them decides anything on the caller's behalf. A missing required field
// is never filled in, a prose request is never parsed into parameters, and an ambiguous alias is never
// guessed. Those get refused, with the exact corrected call attached.
//
// WHERE "SHAPES ONLY" STOPPED BEING THE WHOLE TRUTH. Step 6 rewrites a VALUE — `"SHORT"` becomes
// `"short"` — and calling that a shape repair was a stretch worth naming rather than letting stand. It
// is still on the safe side of the line, for a reason that is checkable rather than rhetorical: the
// service has DECLARED the finite set of strings that key accepts, and a case-insensitive comparison
// against that set either matches exactly one member or none. Nothing is chosen, ranked or preferred;
// there is no second candidate to prefer over. A value matching none is left exactly as the caller
// wrote it — `side: "banana"` is passed through untouched, not coerced to the nearest thing — which is
// the same refusal-to-guess the alias table applies one step up. The response wording was corrected to
// say this outright instead of resting on the phrase "shapes only" (see app.js / mcp.js).
//
// AND REFUSING IS NOT GUESSING. Passing `side: "banana"` through was correct as far as this file goes
// and wrong as far as the CALLER goes: `perpGate.js:29` reads anything unrecognised as LONG, so the
// caller got a confident, self-checked, signed answer about the opposite position. `enumViolations`
// below is the other half — it does not repair the value, it reports that the value matches nothing
// the service declares, so the request can be refused before an engine is reached. Guessing invents a
// value the caller did not write; refusing invents nothing. It is deliberately the exact COMPLEMENT of
// step 6: the same case-insensitive comparison against the same declared set, so a value this file
// would have repaired can never be one the guard refuses, and the two can never disagree about what
// "matches a declared alternative" means.
//
// And every repair is REPORTED in the response. A silent coercion is how a caller ends up billed for
// an answer about a position they did not describe, which is a worse defect than the refusal it
// avoided. This file is under `src/util`, so nothing here moves the published codeHash.

// Wrapper keys frameworks put params under. Unwrapped only when the wrapper is the ONLY key, so a
// body that legitimately contains one of these names is never mistaken for a wrapper.
const WRAPPERS = ['input', 'inputs', 'params', 'parameters', 'arguments', 'args', 'data', 'body', 'payload'];

// Synonyms an agent may reasonably produce. Deliberately narrow: each maps to exactly one canonical
// name, and a synonym is only applied when the canonical key is absent and the target service
// actually has that property. An alias that could mean two things is not in this table.
const ALIASES = {
  token: 'address', tokenAddress: 'address', contract: 'address', contractAddress: 'address',
  symbol: 'currency', ticker: 'currency', asset: 'currency', coin: 'currency',
  network: 'chain', chainId: 'chain', blockchain: 'chain',
  size: 'size', qty: 'size', quantity: 'size', amount: 'size',
  entry: 'entryPrice', entry_price: 'entryPrice', price: 'entryPrice',
  lev: 'leverage', leverageX: 'leverage',
  mmr: 'maintMarginRate', maintenanceMarginRate: 'maintMarginRate',
  protocolName: 'protocol', project: 'protocol',
  marketId: 'market', slug: 'market',
};

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Normalise a request body toward the shape a service declares, reporting every change.
 *
 * @returns {{ body: object, repairs: Array<{kind: string, note: string}> }}
 */
export function repairBody(service, raw) {
  const repairs = [];
  let body = isPlainObject(raw) ? { ...raw } : {};

  const schema = service?.inputSchema || {};
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const known = new Set(Object.keys(props));

  // ---- 1. unwrap ---------------------------------------------------------------------------------
  // Only when the wrapper is the sole key, and only one level, because a body that is entirely one
  // container is unambiguous while a body with a container among other fields is not.
  const keys = Object.keys(body);
  if (keys.length === 1 && WRAPPERS.includes(keys[0]) && isPlainObject(body[keys[0]])) {
    repairs.push({ kind: 'unwrapped', note: `params were nested under "${keys[0]}" and have been read from there` });
    body = { ...body[keys[0]] };
  }

  // ---- 2. key case -------------------------------------------------------------------------------
  // Matched case-insensitively against the declared properties. A key that matches nothing is left
  // exactly as it is, because renaming it would be guessing.
  const lowerToCanonical = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  for (const k of Object.keys(body)) {
    if (known.has(k)) continue;
    const canonical = lowerToCanonical.get(k.toLowerCase());
    if (canonical && !(canonical in body)) {
      body[canonical] = body[k];
      delete body[k];
      repairs.push({ kind: 'recased', note: `"${k}" read as "${canonical}"` });
    }
  }

  // ---- 3. aliases --------------------------------------------------------------------------------
  // `known.has(alias)` is the guard that matters and it was missing. Three services declare an alias
  // key as their OWN property — chart-press and perp-gate have `symbol`, updown-pulse has `coin` —
  // and today those do not fire only because the canonical they map to is not also a property there.
  // That is luck, not design. The day `currency` is added to perp-gate, a caller's `symbol` would be
  // silently moved, the ECHOED INPUTS would change, and with them the contentHash of a request that
  // used to work. A published proof would stop reproducing, which is the one failure this whole
  // project exists to make impossible.
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (alias === canonical) continue;
    if (known.has(alias)) continue;                 // this service means something by that word
    if (alias in body && !(canonical in body) && known.has(canonical)) {
      body[canonical] = body[alias];
      delete body[alias];
      repairs.push({ kind: 'aliased', note: `"${alias}" read as "${canonical}"` });
    }
  }

  // ---- 4. numeric strings ------------------------------------------------------------------------
  // Only where the schema says the field is a number, and only when the whole string is a number.
  // "64,000" and "64k" are refused rather than parsed, because both have more than one reading.
  for (const [k, spec] of Object.entries(props)) {
    if (!(k in body)) continue;
    const wantsNumber = spec.type === 'number' || spec.type === 'integer';
    if (!wantsNumber || typeof body[k] !== 'string') continue;
    const t = body[k].trim();
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) continue;
    body[k] = Number(t);
    repairs.push({ kind: 'parsed', note: `"${k}" arrived as the string "${t}" and was read as the number ${body[k]}` });
  }

  // ---- 5. booleans -------------------------------------------------------------------------------
  for (const [k, spec] of Object.entries(props)) {
    if (!(k in body) || spec.type !== 'boolean' || typeof body[k] !== 'string') continue;
    const t = body[k].trim().toLowerCase();
    if (t !== 'true' && t !== 'false') continue;
    body[k] = t === 'true';
    repairs.push({ kind: 'parsed', note: `"${k}" arrived as the string "${t}" and was read as a boolean` });
  }

  // ---- 6. enum case ------------------------------------------------------------------------------
  // The step that decides whether a caller is told about their own position or the opposite one. It
  // fires only against a DECLARED `enum`, which is why the fix for `side` and option `type` was a
  // schema change rather than a change here: the mechanism was live and had nothing to match against.
  //
  // AND IT HAS TO DESCEND. Two of the three fields that carry direction — an options leg's `type` and a
  // portfolio leg's `side` — live inside an array of objects, and a walk over top-level properties
  // cannot see either. `positions[1].side` was the exact path that turned a hedged book into a doubled
  // long. Only this step descends: unwrapping, aliasing and number parsing stay top-level, because
  // inside an array the caller's key is not the only thing that could have been meant and a wrong guess
  // there is silent. Case against a declared value has one reading or none.
  const recase = (obj, k, spec, label) => {
    if (!(k in obj) || !Array.isArray(spec.enum) || typeof obj[k] !== 'string') return null;
    if (spec.enum.includes(obj[k])) return null;
    const hit = spec.enum.find((e) => String(e).toLowerCase() === obj[k].toLowerCase());
    if (hit == null) return null;
    repairs.push({ kind: 'recased', note: `"${label}": "${obj[k]}" read as "${hit}"` });
    return hit;
  };
  for (const [k, spec] of Object.entries(props)) {
    const hit = recase(body, k, spec, k);
    if (hit != null) body[k] = hit;

    // Copy-on-write into array items. `body` is a SHALLOW copy of the caller's object, so writing into
    // an element in place would mutate the request body the caller still holds — and on the paid path
    // that object is the one the refusal helper echoes back. An untouched array keeps its identity.
    const itemProps = spec?.type === 'array' && spec.items?.properties;
    if (!itemProps || !Array.isArray(body[k])) continue;
    let touched = false;
    const next = body[k].map((el, i) => {
      if (!isPlainObject(el)) return el;
      let copy = el;
      for (const [ik, ispec] of Object.entries(itemProps)) {
        const h = recase(copy, ik, ispec, `${k}[${i}].${ik}`);
        if (h == null) continue;
        if (copy === el) copy = { ...el };
        copy[ik] = h;
        touched = true;
      }
      return copy;
    });
    if (touched) body[k] = next;
  }

  // Missing is reported against the same widened notion of "needed" the example below uses, so a
  // service that expresses its requirements through anyOf is not reported as needing nothing.
  const groups = [
    ...(Array.isArray(schema.allOf) ? schema.allOf : []),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf.slice(0, 1) : []),
  ].flatMap((g) => (Array.isArray(g.required) ? g.required : []));
  const needed = [...new Set([...required, ...groups])].filter((k) => props[k]);
  return { body, repairs, missing: needed.filter((k) => !(k in body)) };
}

/**
 * Every declared-`enum` field whose value matches NO declared alternative, even ignoring case.
 *
 * THE DEFECT THIS CLOSES. Miscasing was fixed by step 6 above; `side: "banana"` was not, and three
 * engines read anything unrecognised as the riskier default — `perpGate.js:29` → long,
 * `portfolioGate.js:30` → long, `optionsRisk.js:32` → call. A caller sending a value the service never
 * declared was billed for a signed answer about a DIFFERENT position than the one they described.
 * Nothing in the response said so, because from the engine's point of view nothing had gone wrong.
 *
 * WHY THIS IS NOT THE THING repairBody REFUSES TO DO. It never proposes a value. It reports, for one
 * key, that the caller's string is not in the finite set the service published for that key — a fact,
 * not a preference. The handler decides what to do with it; both handlers refuse, and both refusals
 * are free (`ok:false` / HTTP 400 before settlement — see x402.isChargeable).
 *
 * THE THREE LIMITS, each deliberate:
 *   - CASE-INSENSITIVE, so it can only ever fire on a value step 6 could not resolve. A stricter guard
 *     than the repairer would refuse values the repair layer considers legal, which is the two halves
 *     of one file disagreeing with each other.
 *   - STRINGS ONLY, the same reach step 6 has. `perpGate.js:29` honours the NUMBER -1 as short and
 *     that is not a declared alternative; refusing it would break a request that answers correctly
 *     today. (The STRING "-1" is honoured too, and is therefore declared — see services.js.)
 *   - TOP LEVEL + ONE ARRAY-ITEM LEVEL, again the same reach, because `positions[1].side` and
 *     `positions[0].type` are two of the three fields that carry direction and neither is top-level.
 *
 * @returns {Array<{path: string, sent: string, allowed: string[]}>} empty when nothing is violated
 */
export function enumViolations(service, body) {
  const props = service?.inputSchema?.properties || {};
  const out = [];
  const check = (obj, k, spec, path) => {
    if (!isPlainObject(obj) || !(k in obj) || !Array.isArray(spec?.enum)) return;
    const v = obj[k];
    if (typeof v !== 'string') return;
    if (spec.enum.some((e) => String(e).toLowerCase() === v.toLowerCase())) return;
    // The service's own words about this key travel WITH the violation. Listing the legal values is
    // the minimum; some fields have more to say than their alternatives — `perp-gate.venue`'s
    // description carries the "the maths is venue-agnostic, pass the numbers yourself" route that a
    // caller on an unsupported venue actually wants, and which used to reach them only from the
    // adapter's refusal, on a code path this guard now gets to first.
    out.push({ path, sent: v, allowed: spec.enum.map(String), ...(spec.description ? { hint: spec.description } : {}) });
  };
  for (const [k, spec] of Object.entries(props)) {
    check(body, k, spec, k);
    const itemProps = spec?.type === 'array' && spec.items?.properties;
    if (!itemProps || !Array.isArray(body?.[k])) continue;
    body[k].forEach((el, i) => {
      for (const [ik, ispec] of Object.entries(itemProps)) check(el, ik, ispec, `${k}[${i}].${ik}`);
    });
  }
  return out;
}

/**
 * The sentence a caller reads. It names the field, quotes what they actually sent, and lists every
 * value that would have worked — the three things missing from "long" arriving where "short" was meant.
 * One wording, built once, used by BOTH surfaces, so the free MCP path and the paid HTTP path cannot
 * drift into describing the same refusal two different ways.
 */
export function enumRefusal(violations) {
  const q = (x) => JSON.stringify(String(x));
  const one = (v) => `unknown value for "${v.path}": ${q(v.sent)} is not one of ${v.allowed.map(q).join(', ')}`
    + (v.hint ? ` (this service says: ${v.hint})` : '');
  return `${violations.map(one).join('; ')} — compared case-insensitively against the alternatives this service declares. `
    + 'Nothing was computed and you were not charged: an unrecognised value used to be served as the engine default, '
    + 'which answered a different position than the one described. Send one of the listed values.';
}

/**
 * The teaching half. When a request still cannot be served after repair, say what is missing and hand
 * back a body that WOULD work, with the caller's own values kept wherever they gave one.
 *
 * A placeholder is written as `<description>` so it is obvious a human or model has to fill it, rather
 * than as a plausible-looking default that could be sent back unread.
 */
export function correctedExample(service, body, missing) {
  const schema = service?.inputSchema || {};
  const props = schema.properties || {};

  // Which keys make a valid call is not always a flat `required` list. perp-gate declares none and
  // expresses "margin OR leverage" through anyOf/allOf instead, so a helper that only read `required`
  // handed back an empty example — a reply that refuses and then shows nothing, which is the least
  // useful refusal there is. Gathered from every place a schema can say "this is needed", with the
  // FIRST anyOf branch taken as one workable option rather than presented as the only one.
  const fromGroups = [
    ...(Array.isArray(schema.allOf) ? schema.allOf : []),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf.slice(0, 1) : []),
  ].flatMap((g) => (Array.isArray(g.required) ? g.required : []));
  const needed = [...new Set([...(schema.required || []), ...fromGroups])].filter((k) => props[k]);

  // Still nothing? Then the schema states its requirements only in prose, and the honest fallback is
  // the properties the caller is most likely to need: those with a description, which is where this
  // service explains itself.
  const keys = needed.length ? needed : Object.keys(props).filter((k) => props[k].description).slice(0, 6);

  const example = {};
  for (const k of keys) {
    const spec = props[k] || {};
    example[k] = k in body ? body[k] : `<${spec.description || spec.type || 'value'}>`;
  }
  // Keep any optional fields the caller already supplied: they meant them.
  for (const k of Object.keys(body)) if (k in props && !(k in example)) example[k] = body[k];

  // …EXCEPT the one they got wrong. "Keep the caller's own values" and "hand back a body that WOULD
  // work" contradict each other for the value the refusal is ABOUT: echoing `side: "banana"` back
  // inside a body labelled as the fix is a corrected example that reproduces the refusal. Replaced
  // with the same `<placeholder>` shape a missing field gets, listing what the service will take.
  // Derived here rather than passed in, so the existing three-argument callers (app.js) get the
  // corrected body without knowing this rule exists — and a body with no violation is untouched, so
  // no refusal message that works today changes.
  const violations = enumViolations(service, body);
  const placeholder = (v) => `<one of: ${v.allowed.join(' | ')}>`;
  for (const v of violations) {
    const m = v.path.match(/^(.+)\[(\d+)\]\.(.+)$/);
    if (!m) { if (v.path in example) example[v.path] = placeholder(v); continue; }
    const [, arr, idx, key] = m;
    if (!Array.isArray(example[arr])) continue;
    // The array in `example` is still the caller's own array by reference; clone before writing or the
    // refusal helper would edit the request body its own caller is still holding.
    example[arr] = structuredClone(example[arr]);
    if (isPlainObject(example[arr][Number(idx)])) example[arr][Number(idx)][key] = placeholder(v);
  }

  const fixNote = violations.length
    ? ` Replace ${violations.map((v) => `"${v.path}"`).join(', ')} with one of the values shown.`
    : '';
  return {
    missing,
    send: { method: 'POST', url: service.path, body: example },
    note: (missing.length
      ? `Fill in ${missing.map((m) => `"${m}"`).join(', ')} and send the body above to ${service.path}.`
      : `Send the body above to ${service.path}.`) + fixNote,
  };
}
