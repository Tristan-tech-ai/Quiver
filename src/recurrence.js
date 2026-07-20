// Recurrence instrumentation — the Phase-1 world-clock milestone is DISTINCT external callers on a REPEAT
// loop, not total sales (self-dealing volume is meaningless; the roadmap's success metric is recurrence).
// This tracks distinct x402 payer addresses and their paid-call counts. In-memory (resets on redeploy), but
// every paid call is ALSO logged to stdout as a structured line, so Railway's persistent logs retain the
// full signal across restarts. Read the summary via the gated /diag/recurrence endpoint.
const callers = new Map(); // payer -> { count, firstSeen, lastSeen, services:Set<string> }
let totalPaidCalls = 0;

/** Record a settled paid call from `payer` for `service`. No-op if the payer is unknown. */
export function recordCall(payer, service) {
  if (!payer || typeof payer !== 'string') return;
  const now = Date.now();
  const c = callers.get(payer) || { count: 0, firstSeen: now, lastSeen: now, services: new Set() };
  c.count += 1;
  c.lastSeen = now;
  if (service) c.services.add(service);
  callers.set(payer, c);
  totalPaidCalls += 1;
  // Structured, greppable log line — survives redeploys in Railway's log store.
  console.log(JSON.stringify({ evt: 'paid_call', payer, service: service || null, callNumberForPayer: c.count, isRepeatCaller: c.count >= 2, distinctPayers: callers.size, ts: now }));
}

/** Phase-1 recurrence summary: distinct payers, how many came back (≥2 calls), and per-caller detail. */
export function recurrenceSummary() {
  const list = [...callers.entries()].map(([payer, c]) => ({
    payer, count: c.count, services: [...c.services], firstSeen: c.firstSeen, lastSeen: c.lastSeen,
  })).sort((a, b) => b.count - a.count);
  const repeat = list.filter((c) => c.count >= 2);
  return {
    distinctPayers: list.length,
    repeatPayers: repeat.length,          // ← the Phase-1 signal: distinct external agents that called AGAIN
    totalPaidCalls,
    callers: list,
    note: 'In-memory since last deploy; full history in Railway stdout logs (grep evt:paid_call). Phase-1 milestone = repeatPayers rising with NON-SELF addresses. Self-dealing (the owner/buyer test wallets) does not count.',
  };
}
