// Mis-route detection: notice when a caller has walked into the wrong shop, and name the right one.
//
// WHY THIS EXISTS, from the on-chain review record rather than from a hunch. Agent #5152 holds twelve
// reviews: ten at five stars and two at half a star, and both of the bad ones are from the same
// reviewer agent, MantaRay, whose own comments say what went wrong:
//
//     "Wrong endpoint: options-desk can't do Aave health checks. No deliverable."
//     "Delivered crypto options/vol data, not the Aave health check that was requested"
//
// It wanted a lending-protocol health check and called `options-desk`. Two other agents ran the same
// Aave task through `protocol-pulse` and scored it 5.0 and 4.8, so the capability was there and
// working. The reviewer picked the wrong service out of a catalogue of twenty-two, and Quiver had no
// way to say so. Twice:
//
//   call 1  the body did not fit options-desk, so it was refused. `inputHint` told the caller what
//           options-desk needs. It did NOT tell them which service does Aave, so the hint was true
//           and useless.
//   call 2  the body DID fit options-desk, so it succeeded and returned a correct options surface to
//           somebody who had asked about a lending protocol. No warning was possible at all.
//
// The second case is the dangerous one and it is the one nothing covered. A service that answers the
// wrong question correctly looks, from the outside, exactly like a service that is wrong.
//
// This file is under `src/util`, not `src/engine`, so nothing here moves the published codeHash.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not reroute the call, and it does not answer on another
// service's behalf. A caller paid for this endpoint; silently serving a different one would be a
// worse failure than the one being fixed. It only ever adds a signpost.

/** Words in a body that hint at a domain, pulled from string values and from key names alike. */
function textOf(body) {
  const out = [];
  const walk = (v, depth) => {
    if (depth > 3 || v == null) return;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.slice(0, 20).forEach((x) => walk(x, depth + 1));
    else if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) { out.push(k); walk(val, depth + 1); }
    }
  };
  walk(body, 0);
  return out.join(' ').toLowerCase();
}

/** Distinctive words from a service's name and blurb, minus the ones every service shares. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'per', 'via', 'plus', 'your', 'you', 'that', 'this', 'into',
  'risk', 'live', 'data', 'crypto', 'onchain', 'on', 'of', 'a', 'an', 'to', 'in', 'is', 'it',
]);
function vocabulary(service) {
  const words = `${service.name} ${service.blurb || ''}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
  return new Set(words);
}

// ── WHAT A SERVICE REQUIRES, when "required" is not one flat list ────────────────────────────────
//
// A MEASURED BLIND SPOT, not a suspected one. `shape` used to read `inputSchema.required`, and eight
// of the twenty-two services declare `required: []` — chart-press, calldata-x, macro-sentry,
// perp-gate, portfolio-gate, size-gate, lp-risk, risk-attest. They declare it honestly: each accepts
// ALTERNATIVE input forms, and no single key is required across all of them. size-gate takes
// {winProb, winLossRatio} OR {expectedReturn, volatility}; perp-gate takes margin OR leverage. There
// is no one list to put in `required` without lying.
//
// The cost was measured before it was fixed, by sweeping all 462 ordered service pairs with a genuine
// body for each accepted form: only 12 of 22 services could ever be NAMED by the signpost. A body
// that is unmistakably a size-gate call, sent to perp-gate, was silent — `foreignWins` needs
// `best.f.shape === 1`, and a service whose required list is empty scores shape 0 forever.
//
// Worse, and not suspected at all: the same empty list made THREE services flag their own correct
// calls. A genuine portfolio-gate call carrying `positions` scored shape 0 against portfolio-gate and
// shape 1 against treasury-risk, so a correct, paid portfolio answer arrived with a notice telling
// the caller they had meant a different service. Both existing silence sweeps (gates/preflight.mjs
// and gates/gateBuyer-mistakes.mjs) skip a service whose `required` is empty, so those three had
// never been looked at. A signpost that fires on a correct call is worse than one that stays quiet on
// a wrong one, because it makes a good answer look wrong.
//
// So this table states, as fact, the alternative key sets each of those services actually accepts.
// Every entry is derived from the service's own `validate()`, not from its description — the
// descriptions were checked against the validators and two of them disagree (see event-vol below).
//
// WHY IT LIVES HERE rather than on the service object. The OKX ASP listing is re-reviewed if the
// advertised surface moves, and re-review during judging pulls all 22 listings back into moderation.
// A field on the service object would have to be PROVEN not to leak into `/` or into MCP
// `tools/list`; a table keyed by name in this file cannot leak, because the field never touches a
// service object at all. The cost is that it can drift from the schemas, and that cost is paid off in
// gates/preflight.mjs, which fails if a declared key is not a real property of that service, if the
// table disagrees with a schema that already declares its own anyOf/allOf, or if a service declares
// `required: []` and is missing from this table entirely.
//
// The two shapes a service can express:
//   anyOf   a list of alternative complete sets — satisfy any ONE of them
//   allOf   a list of groups, each of which must be satisfied by any one of its options; expanded
//           into the equivalent list of alternative complete sets
const anyOf = (...sets) => sets;
const allOf = (...groups) => groups.reduce(
  (acc, group) => acc.flatMap((base) => group.map((k) => [...new Set([...base, k])])),
  [[]],
).map((s) => s.sort());

export const REQUIRED_ALTERNATIVES = {
  // validate(): a CEX `symbol` that looks like a pair, OR a DEX token (chain + address).
  'chart-press': anyOf(['symbol'], ['chain', 'address']),
  // validate(): an EIP-712 `typedData` signing request, OR `data` calldata hex.
  'calldata-x': anyOf(['data'], ['typedData']),
  // validate() NEVER refuses: every field defaults (hours defaults to 72), so an empty body is a
  // complete call. Declaring any key here would be a fiction. The consequence is stated rather than
  // hidden: macro-sentry can never be named by the shape signal, because it has no shape to match.
  'macro-sentry': anyOf(),
  // Already published in perp-gate's own inputSchema.allOf, and enforced identically in validate():
  // a price source, a size, collateral, and a maintenance-margin source, each satisfied by any one
  // option in its group.
  'perp-gate': allOf(['entryPrice', 'symbol'], ['size', 'notional'], ['margin', 'leverage'], ['maintMarginRate', 'maxLeverage', 'symbol']),
  // Already published in portfolio-gate's own inputSchema.anyOf.
  'portfolio-gate': anyOf(['positions'], ['account']),
  'size-gate': anyOf(['winProb', 'winLossRatio'], ['expectedReturn', 'volatility']),
  'lp-risk': anyOf(['priceRatio'], ['volatility']),
  'risk-attest': anyOf(['items'], ['contentHashes']),

  // ── two services whose declared `required` UNDERSTATES what their validator demands ────────────
  // These are not in the eight. Both are reachable already, and the defect is the other direction: a
  // body carrying only the declared keys scored shape 1 and pulled redirects it had not earned.
  // exec-verify refuses without a pricing reference, and event-vol refuses without a vol and a
  // horizon, so those are requirements in fact and belong in the shape signal as such.
  'exec-verify': anyOf(['amountIn', 'amountOutRealized', 'reserveIn', 'reserveOut', 'feeTier'], ['amountIn', 'amountOutRealized', 'fairPrice']),
  'event-vol': allOf(['spot'], ['atmIvPct', 'atmIv'], ['daysToEvent', 'T']),
};

/**
 * The complete input forms a service accepts, as a list of key sets. A body satisfies the service
 * when it carries every key of ANY ONE set. Falls back to the flat `required` list, so the fourteen
 * services that state their requirements that way score exactly as they did before.
 */
export function requiredAlternatives(service) {
  const declared = REQUIRED_ALTERNATIVES[service?.name];
  if (declared) return declared;
  const req = service?.inputSchema?.required || [];
  return req.length ? [req] : [];
}

/**
 * Score how well a body fits a service. Two independent signals, kept separate on purpose so a
 * strong match on one cannot be manufactured by the other:
 *
 *   shape    does the body carry a complete set of this service's REQUIRED keys? This is the hard
 *            evidence, because what a service requires is a fact about the service rather than a
 *            guess about intent. `anyOfRequired` above widens WHICH sets count as complete; it does
 *            not soften what counts as evidence, and it is not allowed anywhere near `words`.
 *   words    do the body's strings and key names overlap this service's vocabulary? Weak evidence,
 *            and weighted as such, but it is the only signal available when a caller sends prose.
 */
export function fitScore(service, body) {
  const alternatives = requiredAlternatives(service);
  const props = Object.keys(service?.inputSchema?.properties || {});
  const keys = body && typeof body === 'object' ? Object.keys(body) : [];
  const keySet = new Set(keys);

  // The closest form decides. Ties on fraction go to the more specific form, so the reason a caller
  // is shown names the fuller set it actually matched rather than an accidental one-key subset.
  let shape = 0, satisfied = 0, form = [];
  for (const alt of alternatives) {
    if (!alt.length) continue;
    const hit = alt.filter((k) => keySet.has(k)).length;
    const s = hit / alt.length;
    if (s > shape || (s === shape && alt.length > form.length)) { shape = s; satisfied = hit; form = alt; }
  }

  // Optional keys count for a little: a body carrying three of a service's optional params is
  // evidence even when a required one is missing.
  const optional = props.filter((k) => keySet.has(k) && !form.includes(k)).length;

  const text = textOf(body);
  const vocab = vocabulary(service);
  let hits = 0;
  for (const w of vocab) if (text.includes(w)) hits++;
  const words = vocab.size ? hits / vocab.size : 0;

  return { shape, words, optional, score: shape * 3 + words * 2 + Math.min(optional, 3) * 0.2, satisfied, required: form.length, form };
}

/**
 * Which of two candidates has the STRONGER claim on a body. Lexicographic on purpose, because the
 * order is the whole point: it says which kind of evidence outranks which, and a single blended
 * number cannot say that.
 *
 *   1. a complete form beats an incomplete one
 *   2. among complete forms, the one that matched MORE required keys — a count of facts, not a guess
 *   3. only then the combined score, where vocabulary finally gets a vote
 *
 * MEASURED, not assumed. Ranking on the blended score alone let the weak signal decide cases the
 * strong one had already settled: a body of {symbol, notional, leverage} satisfies three of
 * perp-gate's required keys and exactly one of chart-press's, and chart-press won it 3.18 to 3.10 on
 * vocabulary overlap alone. Same for {chain, wallet}, which is two of loop-digest's required keys and
 * one of poly-desk's, and went to poly-desk. Rule 2 is not a new signal — `satisfied` was already
 * computed and then thrown away by dividing it into a fraction.
 */
function stronger(a, b) {
  const ca = a.shape === 1, cb = b.shape === 1;
  if (ca !== cb) return ca;
  if (ca && a.satisfied !== b.satisfied) return a.satisfied > b.satisfied;
  return a.score > b.score;
}

/**
 * Given the service that was called and the body it received, is there a DIFFERENT service that fits
 * the request clearly better?
 *
 * Returns null unless the evidence is strong, because a signpost that fires on ordinary calls is
 * noise, and noise in a paid response is worse than no signpost. "Clearly better" means the other
 * service's required keys are fully satisfied while this one's are not, or the other outscores this
 * one by a wide margin on the combined signal.
 */
export function suggestService(calledService, body, allServices) {
  if (!calledService || !Array.isArray(allServices) || !body || typeof body !== 'object') return null;
  if (!Object.keys(body).length) return null;

  const here = fitScore(calledService, body);
  let best = null;
  for (const s of allServices) {
    if (s.name === calledService.name) continue;
    const f = fitScore(s, body);
    if (!best || stronger(f, best.f)) best = { s, f };
  }
  if (!best) return null;

  // Hard evidence first: the other service's requirements are met and this one's are not.
  const shapeWins = best.f.required > 0 && best.f.shape === 1 && here.shape < 1;

  // THE CASE THAT ACTUALLY COST TWO STARS, and the one the first version of this file missed. A body
  // can satisfy THIS service perfectly and still be aimed somewhere else, because it carries a key
  // this service has never heard of that is another service's required field. MantaRay's second call
  // was exactly that: `currency` satisfied options-desk, and `protocol` sat there in the same body
  // meaning nothing to it. The call succeeded, the options surface was correct, and the answer was to
  // a question nobody asked. A refusal message cannot help here because nothing was refused.
  //
  // `!mine.has(k)` is the guard that carries this whole branch: a key is only foreign if the service
  // that was called does not declare it as its own property. Three services declare `symbol` and
  // three declare `positions`, and without that check a caller's own field would be read as evidence
  // for somewhere else. The foreign key must also be one the OTHER service requires in the very form
  // it matched — not merely a key it accepts — or an optional field would carry a redirect.
  const mine = new Set(Object.keys(calledService?.inputSchema?.properties || {}));
  const foreign = Object.keys(body).filter((k) => !mine.has(k) && best.f.form.includes(k));
  const foreignWins = best.f.shape === 1 && foreign.length > 0;

  // Otherwise demand a wide margin, so a near-tie stays silent.
  const marginWins = best.f.score >= here.score + 1.5 && best.f.score > 1.2;

  if (!shapeWins && !foreignWins && !marginWins) return null;

  return {
    service: best.s.name,
    endpoint: best.s.path,
    price: best.s.price,
    because: foreignWins && !shapeWins
      ? `the request also carries ${foreign.join(', ')}, which ${calledService.name} does not use and ${best.s.name} requires — this call will succeed here and answer a different question from the one asked`
      : shapeWins
      ? `the request carries every field ${best.s.name} requires (${best.f.form.join(', ')}), and ${calledService.name} is missing ${here.form.filter((k) => !(k in body)).join(', ') || 'its own'}`
      : `the request reads like ${best.s.name}: ${best.s.blurb}`.slice(0, 200),
    retry: { method: 'POST', url: best.s.path, body },
  };
}

/**
 * The line to attach to a REFUSAL. A refusal that says what this service needs is true; a refusal
 * that also says which service does what you asked is useful.
 */
export function redirectLine(calledService, body, allServices) {
  const hit = suggestService(calledService, body, allServices);
  if (!hit) return null;
  return `This looks like a job for ${hit.service} rather than ${calledService.name}. Retry: POST ${hit.endpoint} with the same body (${hit.price} USDT).`;
}
