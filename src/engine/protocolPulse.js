// ProtocolPulse — one call: a DeFi protocol health dossier (TVL now + trend + max drawdown,
// chain concentration, age, and the full hack/incident record) → a machine-readable risk grade.
// Yield-allocating agents gate every deposit/rebalance on this.
import * as llama from '../adapters/defillama.js';
import { config } from '../config.js';
import { round } from './stats.js';

const DAY = 86400000;

export async function protocolPulse(query, deps = llama) {
  const t0 = Date.now();
  const meta = await deps.resolveProtocol(query);
  if (!meta) return { service: 'protocol-pulse', version: config.version, query, verdict: 'NOT_FOUND', note: `No DeFi protocol matched "${query}" on DefiLlama.` };

  // A failed hack-registry fetch must NOT read as "no incidents" — absence-as-success is the exact
  // defect class this codebase already shipped once (see VERIFIER_DISCIPLINE instance 15). Track it.
  let registryUnavailable = false;
  const [p, allHacks] = await Promise.all([
    deps.protocol(meta.slug),
    deps.hacks().catch(() => { registryUnavailable = true; return []; }),
  ]);

  // TVL series (aggregate).
  const series = (p.tvl || []).map((x) => ({ t: x.date * 1000, v: x.totalLiquidityUSD })).filter((x) => x.v != null);
  const now = Date.now();
  const cur = series.length ? series[series.length - 1].v : (p.currentChainTvls ? Object.values(p.currentChainTvls).reduce((a, b) => a + b, 0) : meta.tvl);
  const at = (daysAgo) => { const target = now - daysAgo * DAY; let best = null; for (const s of series) if (s.t <= target) best = s; return best?.v; };
  const tvl7 = at(7), tvl30 = at(30);
  const chg7 = tvl7 ? round(((cur - tvl7) / tvl7) * 100, 1) : null;
  const chg30 = tvl30 ? round(((cur - tvl30) / tvl30) * 100, 1) : null;

  // Max drawdown over the last 90 days.
  let maxDd = null;
  if (series.length > 5) {
    const recent = series.filter((s) => s.t > now - 90 * DAY);
    let peak = -Infinity, dd = 0;
    for (const s of recent) { if (s.v > peak) peak = s.v; if (peak > 0) dd = Math.min(dd, (s.v - peak) / peak); }
    maxDd = round(dd * 100, 1);
  }

  // Chain concentration.
  const chainTvls = p.currentChainTvls || {};
  const chainEntries = Object.entries(chainTvls).filter(([k]) => !/-(borrowed|staking|pool2|treasury|vesting)$/i.test(k));
  const chainTotal = chainEntries.reduce((a, [, v]) => a + v, 0) || cur || 1;
  const topChain = chainEntries.sort((a, b) => b[1] - a[1])[0];
  const chainConcentration = topChain ? round((topChain[1] / chainTotal) * 100, 1) : null;

  // Age.
  const firstT = series.length ? series[0].t : null;
  const ageDays = firstT ? round((now - firstT) / DAY, 0) : null;

  // Data freshness: every TVL-derived number above is only as fresh as the last series point. Disclose it
  // instead of letting a lagged/stale DefiLlama series silently masquerade as "now".
  const lastPointT = series.length ? series[series.length - 1].t : null;
  const tvlAgeHours = lastPointT != null ? round((now - lastPointT) / 3600000, 1) : null;

  // Incident record: match hacks by protocol name.
  const nameL = (p.name || meta.name).toLowerCase();
  const incidents = allHacks.filter((h) => String(h.name || '').toLowerCase() === nameL || String(h.name || '').toLowerCase().includes(nameL))
    .map((h) => ({ date: h.date ? new Date(h.date * 1000).toISOString().slice(0, 10) : null, amountUsd: h.amount ? round(h.amount) : null, technique: h.technique, classification: h.classification }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // DESCRIPTIVE, rule-based risk read — deliberately NOT a fitted composite score (D19). A single 0-100
  // "health grade" implies a calibrated, out-of-sample-validated model; we have no labeled protocol-failure
  // dataset to validate weights against, so a hand-tuned composite would be goal-seeking (exactly what the
  // quant standard forbids). Instead: surface the factual signals, and flag the specific risk CONDITIONS
  // present. Each flag is a single, individually-defensible condition with its threshold and rationale
  // disclosed — no hidden weights, no false 0-100 precision.
  const recentHack = incidents.find((i) => i.date && Date.parse(i.date) > now - 365 * DAY);
  const flags = [];
  if (recentHack) flags.push({ severity: 'high', flag: 'HACK_LAST_12MO', detail: `Security exploit on ${recentHack.date}${recentHack.amountUsd ? ` (~$${round(recentHack.amountUsd)})` : ''} — a failure of this protocol's own security within the last year.` });
  else if (incidents.length) flags.push({ severity: 'medium', flag: 'PRIOR_INCIDENT_ON_RECORD', detail: `${incidents.length} historical incident(s) in the hack registry (most recent ${incidents[0].date}) — older than 12 months but part of the record.` });
  if (maxDd !== null && maxDd <= -50) flags.push({ severity: 'medium', flag: 'DEEP_DRAWDOWN_90D', detail: `TVL fell ${Math.abs(maxDd)}% peak-to-trough within the last 90 days — capital left or was marked down sharply.` });
  if (chg30 !== null && chg30 <= -35) flags.push({ severity: 'medium', flag: 'TVL_OUTFLOW_30D', detail: `TVL is down ${Math.abs(chg30)}% over the last 30 days — a sustained outflow, not a one-day dip.` });
  if (ageDays !== null && ageDays < 90) flags.push({ severity: 'medium', flag: 'VERY_NEW_PROTOCOL', detail: `Only ${ageDays} days of TVL history — unproven across a full market/stress cycle.` });
  if (cur < 1e6) flags.push({ severity: 'medium', flag: 'MICRO_TVL', detail: `Under $1M TVL — thin enough to be easily manipulated and frequently abandoned.` });
  if (chainConcentration !== null && chainConcentration > 97 && Object.keys(chainTvls).length > 1) flags.push({ severity: 'low', flag: 'SINGLE_CHAIN_DEPENDENCY', detail: `${chainConcentration}% of TVL sits on ${topChain[0]} — a single-chain outage/exploit hits nearly all of it.` });
  if (tvlAgeHours !== null && tvlAgeHours > 48) flags.push({ severity: 'low', flag: 'STALE_TVL_SERIES', detail: `The latest TVL point is ${tvlAgeHours}h old — level, trend, and drawdown above are computed on stale data.` });
  if (registryUnavailable) flags.push({ severity: 'medium', flag: 'INCIDENT_REGISTRY_UNAVAILABLE', detail: 'The hack registry could not be fetched — the incident record is UNKNOWN for this call, not clean. riskLevel cannot read BASELINE while a load-bearing input is unknown.' });
  // riskLevel is a TRANSPARENT function of the flags (any high → ELEVATED; any medium → WATCH; none →
  // BASELINE), not a scored model. "BASELINE" means no flagged risk condition — NOT a safety endorsement.
  const riskLevel = flags.some((f) => f.severity === 'high') ? 'ELEVATED' : flags.some((f) => f.severity === 'medium') ? 'WATCH' : 'BASELINE';

  return {
    service: 'protocol-pulse',
    version: config.version,
    protocol: p.name || meta.name, slug: meta.slug, category: p.category || meta.category,
    riskLevel, riskFlags: flags,
    tvl: { currentUsd: round(cur), change7dPct: chg7, change30dPct: chg30, maxDrawdown90dPct: maxDd },
    dataFreshness: { lastTvlPointUtc: lastPointT != null ? new Date(lastPointT).toISOString() : null, tvlAgeHours, seriesPoints: series.length, incidentRegistryFetched: !registryUnavailable },
    footprint: { chains: (p.chains || meta.chains || []).slice(0, 8), topChain: topChain ? topChain[0] : null, topChainConcentrationPct: chainConcentration, ageDays },
    incidents: registryUnavailable
      ? { count: null, hadHackLast12mo: null, history: [], registryUnavailable: true, note: 'Hack registry fetch FAILED this call — an unknown record, not a clean one.' }
      : { count: incidents.length, hadHackLast12mo: !!recentHack, history: incidents.slice(0, 5) },
    method: 'DefiLlama TVL history (level, 7/30-day trend, 90-day max drawdown), chain concentration, protocol age, and the DefiLlama hack registry — reported as factual signals plus a set of individually-defensible risk FLAGS. We deliberately do NOT collapse these into a single 0-100 health score or letter grade: that would imply a calibrated predictive model, and with no labeled protocol-failure dataset to back-test weights, a hand-tuned composite would be goal-seeking. riskLevel is a transparent function of the flags present, not a scored model.',
    limitations: 'TVL and hack data are as-reported by DefiLlama; incident matching is by protocol name (a rename or subsidiary can be missed). riskLevel=BASELINE means no flagged condition was detected — it is NOT an audit, a safety endorsement, or a guarantee against exploits. Every flag threshold is disclosed above. Research signal, not investment advice.',
    elapsedMs: Date.now() - t0,
  };
}
