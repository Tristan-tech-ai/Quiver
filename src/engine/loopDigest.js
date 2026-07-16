// LoopDigest — one call at the top of an agent's loop: a compact diff of a wallet's world since
// the caller's last call (cursor-based). New fills + per-token PnL drift, context-budgeted so the
// agent reads one small object instead of re-fetching (and re-paying context for) everything.
import * as data from '../adapters/data.js';
import { config } from '../config.js';
import { round } from './stats.js';

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

// Cursor store: id -> { wallet, chain, snapshot, t }. Caller passes the last cursor to diff against.
const snaps = new Map();
let seq = 0;
function saveSnap(chain, wallet, snapshot) {
  seq = (seq + 1) % 1e6;
  const id = `${Date.now().toString(36)}${seq.toString(36)}`;
  snaps.set(id, { chain, wallet, snapshot, t: Date.now() });
  if (snaps.size > 5000) { const cut = Date.now() - 24 * 3600 * 1000; for (const [k, v] of snaps) if (v.t < cut) snaps.delete(k); }
  return id;
}

const TYPE = { '1': 'buy', '2': 'sell', '3': 'transfer-in', '4': 'transfer-out' };

// Per-token state from the transaction list (latest pnlUsd/valueUsd per token).
function tokenState(txs) {
  const m = {};
  for (const t of txs) {
    const addr = t.tokenContractAddress || t.tokenAddress;
    if (!addr) continue;
    if (!m[addr]) m[addr] = { symbol: t.tokenSymbol, pnlUsd: num(t.pnlUsd), valueUsd: num(t.valueUsd), t: num(t.time) };
  }
  return m;
}

export async function loopDigest({ chain, wallet, cursor = null }) {
  const t0 = Date.now();
  const historyRaw = await data.portfolioDexHistory(chain, wallet).catch(() => ({}));
  const d = historyRaw?.data ?? historyRaw ?? {};
  const txs = (d.transactionList || d.transactions || d.list || (Array.isArray(d) ? d : [])).map((h) => ({ ...h }));
  txs.sort((a, b) => (num(b.time) || 0) - (num(a.time) || 0)); // newest first
  const curState = tokenState(txs);
  const lastTxTime = txs.length ? num(txs[0].time) || 0 : 0;
  const nowSnap = { lastTxTime, state: curState };

  let diff = null;
  if (cursor && snaps.has(cursor)) {
    const prev = snaps.get(cursor).snapshot;
    const newFills = txs.filter((h) => (num(h.time) || 0) > (prev.lastTxTime || 0))
      .slice(0, 20).map((h) => ({ type: TYPE[h.type] || h.type, token: h.tokenSymbol, valueUsd: round(num(h.valueUsd)), pnlUsd: round(num(h.pnlUsd)), time: num(h.time) }));
    const drift = [];
    for (const [addr, cur] of Object.entries(curState)) {
      const before = prev.state?.[addr];
      const dv = (cur.pnlUsd || 0) - (before?.pnlUsd || 0);
      if (Math.abs(dv) >= 1 || !before) drift.push({ token: cur.symbol, pnlDeltaUsd: round(dv), pnlNowUsd: round(cur.pnlUsd), isNew: !before });
    }
    drift.sort((a, b) => Math.abs(b.pnlDeltaUsd) - Math.abs(a.pnlDeltaUsd));
    diff = { newFills, newFillCount: newFills.length, pnlDrift: drift.slice(0, 10), sinceCursor: cursor };
  }

  const newCursor = saveSnap(chain, wallet, nowSnap);
  return {
    service: 'loop-digest',
    version: config.version,
    chain, wallet,
    cursor: newCursor,
    baseline: !diff,
    diff: diff || { note: 'First call for this wallet (no prior cursor) — baseline stored. Pass this response\'s cursor next call to get only what changed.' },
    positionsTracked: Object.keys(curState).length,
    method: 'Cursor-based state diff: stores a per-call snapshot (last fill time + per-token PnL) and, given the prior cursor, returns only new fills and PnL drift since then — a compact loop-top read instead of a full re-fetch.',
    limitations: 'Diff is relative to the cursor you pass; snapshots expire after 24h. Covers DEX fills and per-token PnL as reported by the market API.',
    elapsedMs: Date.now() - t0,
  };
}
