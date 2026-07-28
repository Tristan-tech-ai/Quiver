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

/**
 * Score how well a body fits a service. Two independent signals, kept separate on purpose so a
 * strong match on one cannot be manufactured by the other:
 *
 *   shape    does the body carry this service's REQUIRED keys? This is the hard evidence, because a
 *            required key is a fact about the service rather than a guess about intent.
 *   words    do the body's strings and key names overlap this service's vocabulary? Weak evidence,
 *            and weighted as such, but it is the only signal available when a caller sends prose.
 */
export function fitScore(service, body) {
  const req = service?.inputSchema?.required || [];
  const props = Object.keys(service?.inputSchema?.properties || {});
  const keys = body && typeof body === 'object' ? Object.keys(body) : [];
  const keySet = new Set(keys);

  const satisfied = req.filter((k) => keySet.has(k)).length;
  const shape = req.length ? satisfied / req.length : 0;

  // Optional keys count for a little: a body carrying three of a service's optional params is
  // evidence even when a required one is missing.
  const optional = props.filter((k) => keySet.has(k) && !req.includes(k)).length;

  const text = textOf(body);
  const vocab = vocabulary(service);
  let hits = 0;
  for (const w of vocab) if (text.includes(w)) hits++;
  const words = vocab.size ? hits / vocab.size : 0;

  return { shape, words, optional, score: shape * 3 + words * 2 + Math.min(optional, 3) * 0.2, satisfied, required: req.length };
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
    if (!best || f.score > best.f.score) best = { s, f };
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
  const mine = new Set(Object.keys(calledService?.inputSchema?.properties || {}));
  const foreign = Object.keys(body).filter((k) => !mine.has(k) && (best.s.inputSchema?.required || []).includes(k));
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
      ? `the request carries every field ${best.s.name} requires (${(best.s.inputSchema.required || []).join(', ')}), and ${calledService.name} is missing ${(calledService.inputSchema?.required || []).filter((k) => !(k in body)).join(', ') || 'its own'}`
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
