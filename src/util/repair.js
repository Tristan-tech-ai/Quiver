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
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (alias === canonical) continue;
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
  for (const [k, spec] of Object.entries(props)) {
    if (!(k in body) || !Array.isArray(spec.enum) || typeof body[k] !== 'string') continue;
    if (spec.enum.includes(body[k])) continue;
    const hit = spec.enum.find((e) => String(e).toLowerCase() === body[k].toLowerCase());
    if (hit != null) {
      repairs.push({ kind: 'recased', note: `"${k}": "${body[k]}" read as "${hit}"` });
      body[k] = hit;
    }
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
  return {
    missing,
    send: { method: 'POST', url: service.path, body: example },
    note: missing.length
      ? `Fill in ${missing.map((m) => `"${m}"`).join(', ')} and send the body above to ${service.path}.`
      : `Send the body above to ${service.path}.`,
  };
}
