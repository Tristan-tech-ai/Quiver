// event-vol — the options-implied EXPECTED MOVE around a scheduled event. This is the depth macro calendars
// lack: Trading Economics / Finnhub / Forex Factory give the date and an "impact: high/med/low" LABEL, but
// not the market's own priced-in magnitude. Given the coin's spot and ATM implied vol, this returns the
// 1-sigma move and the straddle-implied expected absolute move; given the vol term structure around the
// event (an expiry just before vs just after), it ISOLATES the event's own contribution — the Wright
// "event-day options" technique (front straddle minus back straddle).
//
// GROUND TRUTH & SELF-CHECK: for r=0 the ATM straddle price IS the risk-neutral expected absolute move,
// E|S_T − S₀|. We compute it from Black-76 and VERIFY it against a numerical integral of |S_T − S₀| over the
// martingale lognormal — an independent check that a wrong expected-move number fails. Event variance from
// the term structure must be non-negative (σ_after²·T_after ≥ σ_before²·T_before); if it isn't, the term
// structure does not isolate a positive event move and we disclose that rather than emit a fabricated one.
import { black76, probAbove } from './black76.js';
import { round } from './stats.js';

const asDecimalIv = (p) => (Number(p.atmIvPct) > 0 ? Number(p.atmIvPct) / 100 : Number(p.atmIv));

// numerical risk-neutral E|S_T − S| under the martingale lognormal — independent of the option formula.
function numericalExpectedAbsMove(S, sig, T) {
  const sd = sig * Math.sqrt(T);
  let sum = 0, w = 0;
  const N = 500, lo = -7, hi = 7;
  for (let i = 0; i <= N; i++) {
    const z = lo + ((hi - lo) * i) / N;
    const pdf = Math.exp(-0.5 * z * z);
    const ST = S * Math.exp(-0.5 * sd * sd + sd * z);
    sum += pdf * Math.abs(ST - S);
    w += pdf;
  }
  return sum / w;
}

export function eventVol(input = {}, { eps = 1e-4 } = {}) {
  const S = Number(input.spot);
  const sig = asDecimalIv(input);
  const T = Number(input.T) > 0 ? Number(input.T) : (Number(input.daysToEvent) > 0 ? Number(input.daysToEvent) / 365 : NaN);
  if (!(S > 0) || !(sig > 0) || !(T > 0)) {
    return { ok: false, errors: ['need spot>0, atmIv (decimal) or atmIvPct, and T (years) or daysToEvent>0'] };
  }
  const sd = sig * Math.sqrt(T);
  const move1Sigma = S * sd;

  // Risk-neutral expected absolute move = ATM straddle (r=0). Verified vs a numerical integral.
  const call = black76(S, S, T, sig, 'call', 0);
  const put = black76(S, S, T, sig, 'put', 0);
  const straddle = call.price + put.price;
  const numer = numericalExpectedAbsMove(S, sig, T);
  const straddleRes = Math.abs(straddle - numer);

  // Probability the move exceeds a set of thresholds (risk-neutral, from the smile-free ATM vol).
  const probBeyond = (movePct) => {
    const up = probAbove(S, S * (1 + movePct / 100), T, sig, 0);        // P(S_T > +move)
    const dn = 1 - probAbove(S, S * (1 - movePct / 100), T, sig, 0);    // P(S_T < -move)
    return round((up + dn) * 100, 1);
  };
  const thresholds = Array.isArray(input.thresholdsPct) && input.thresholdsPct.length ? input.thresholdsPct : [1, 2, 5];

  // Event isolation from the term structure (optional): σ_after²·T_after − σ_before²·T_before.
  let eventIsolation = null;
  const ivB = input.ivBeforePct != null || input.ivBefore != null ? asDecimalIv({ atmIvPct: input.ivBeforePct, atmIv: input.ivBefore }) : null;
  const ivA = input.ivAfterPct != null || input.ivAfter != null ? asDecimalIv({ atmIvPct: input.ivAfterPct, atmIv: input.ivAfter }) : null;
  const TB = Number(input.TBefore) > 0 ? Number(input.TBefore) : (Number(input.daysBefore) > 0 ? Number(input.daysBefore) / 365 : null);
  const TA = Number(input.TAfter) > 0 ? Number(input.TAfter) : (Number(input.daysAfter) > 0 ? Number(input.daysAfter) / 365 : null);
  if (ivB > 0 && ivA > 0 && TB > 0 && TA > 0) {
    const varBefore = ivB * ivB * TB, varAfter = ivA * ivA * TA;
    const eventVar = varAfter - varBefore;
    eventIsolation = {
      valid: eventVar >= 0,
      eventVariance: Number(eventVar.toExponential(3)),
      eventMove1SigmaUsd: eventVar >= 0 ? round(S * Math.sqrt(eventVar), 2) : null,
      eventMovePct: eventVar >= 0 ? round(100 * Math.sqrt(eventVar), 3) : null,
      note: eventVar >= 0
        ? 'Event move isolated from the vol term structure (post-event expiry variance minus pre-event) — the Wright event-day technique. This strips the baseline diffusion and leaves the market\'s priced-in jump for the event.'
        : 'The pre-event expiry carries MORE total variance than the post-event expiry — the term structure does not isolate a positive event move. Check the expiries (after must span the event, before must not).',
    };
  }

  return {
    ok: true,
    spot: S, atmIvPct: round(sig * 100, 2), horizonDays: round(T * 365, 2),
    expectedMove: {
      oneSigmaUsd: round(move1Sigma, 2),
      oneSigmaPct: round(sd * 100, 3),
      straddleImpliedAbsMoveUsd: round(straddle, 2),        // risk-neutral E|S_T − S|
      rangeOneSigma: [round(S - move1Sigma, 2), round(S + move1Sigma, 2)],
    },
    probabilityMoveBeyond: thresholds.map((x) => ({ thresholdPct: x, probPct: probBeyond(x) })),
    eventIsolation,
    method: 'Expected move from ATM implied vol: 1σ = spot·σ·√T; the straddle is the risk-neutral expected ABSOLUTE move E|S_T−S₀|. Event isolation subtracts pre-event from post-event total variance (Wright). Uses the ATM vol only — a full smile (options-desk) refines the tails.',
    checks: [
      { name: 'straddle == numerical E|S_T−S₀| (independent integral)', residual: Number(straddleRes.toExponential(2)), tolerance: Number((eps * Math.max(1, S)).toExponential(2)), pass: straddleRes <= eps * Math.max(1, S) },
    ],
  };
}
