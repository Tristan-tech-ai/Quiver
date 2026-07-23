// LoopDigest — one call at the top of an agent's loop: a compact diff of a wallet's world since
// the caller's last call (cursor-based). New fills + per-token PnL drift, context-budgeted so the
// agent reads one small object instead of re-fetching (and re-paying context for) everything.
import * as data from '../adapters/data.js';
import { config } from '../config.js';
import { round } from './stats.js';

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

// Cursor store: id -> { wallet, chain, snapshot, t }. Caller passes the last cursor to diff against.
// IN-MEMORY: snapshots do not survive a process restart — that is why an unknown cursor is DISCLOSED
// (cursorStatus) instead of being silently treated as a first call.
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

export async function loopDigest({ chain, wallet, cursor = null }, deps = data) {
  const t0 = Date.now();

  // A failed history fetch must NOT masquerade as "no activity" — and must never be SAVED as a
  // snapshot (an empty poisoned baseline would make every position look new on the next diff).
  let fetchOk = true;
  const historyRaw = await deps.portfolioDexHistory(chain, wallet).catch(() => { fetchOk = false; return {}; });
  if (!fetchOk) {
    return {
      service: 'loop-digest', version: config.version, chain, wallet,
      dataUnavailable: true,
      cursor: cursor || null, cursorStatus: 'unchanged',
      note: 'The DEX-history fetch FAILED this call — this is an unknown state, not an empty one. Your previous cursor is returned untouched; retry with it (no snapshot was stored, so continuity is preserved).',
      elapsedMs: Date.now() - t0,
    };
  }

  const d = historyRaw?.data ?? historyRaw ?? {};
  const txs = (d.transactionList || d.transactions || d.list || (Array.isArray(d) ? d : [])).map((h) => ({ ...h }));
  txs.sort((a, b) => (num(b.time) || 0) - (num(a.time) || 0)); // newest first
  const curState = tokenState(txs);
  const lastTxTime = txs.length ? num(txs[0].time) || 0 : 0;
  const oldestTxTime = txs.length ? num(txs[txs.length - 1].time) || 0 : 0;
  const nowSnap = { lastTxTime, state: curState };

  // Cursor semantics, disclosed: 'diffed' (found + diff returned), 'baseline-stored' (no cursor passed),
  // 'unknown-rebaselined' (cursor passed but NOT found — expired or the service instance restarted; the
  // agent's diff continuity is broken and it must know that, not silently receive a fresh baseline).
  const cursorKnown = cursor ? snaps.has(cursor) : false;
  let diff = null, diffComplete = null;
  if (cursorKnown) {
    const prev = snaps.get(cursor).snapshot;
    // If the fetched history window does not reach back to the cursor's last fill, fills in the gap are
    // invisible to this diff — disclose completeness instead of implying the diff is exhaustive.
    diffComplete = txs.length === 0 ? true : oldestTxTime <= (prev.lastTxTime || 0);
    const newFills = txs.filter((h) => (num(h.time) || 0) > (prev.lastTxTime || 0))
      .slice(0, 20).map((h) => ({ type: TYPE[h.type] || h.type, token: h.tokenSymbol, valueUsd: round(num(h.valueUsd)), pnlUsd: round(num(h.pnlUsd)), time: num(h.time) }));
    const drift = [];
    for (const [addr, cur] of Object.entries(curState)) {
      const before = prev.state?.[addr];
      const dv = (cur.pnlUsd || 0) - (before?.pnlUsd || 0);
      if (Math.abs(dv) >= 1 || !before) drift.push({ token: cur.symbol, pnlDeltaUsd: round(dv), pnlNowUsd: round(cur.pnlUsd), isNew: !before });
    }
    drift.sort((a, b) => Math.abs(b.pnlDeltaUsd) - Math.abs(a.pnlDeltaUsd));
    diff = {
      newFills, newFillCount: newFills.length, pnlDrift: drift.slice(0, 10), sinceCursor: cursor,
      diffComplete,
      ...(diffComplete ? {} : { note: `The fetched history window (oldest fill ${oldestTxTime}) does not reach back to your cursor's last fill (${prev.lastTxTime}) — fills in the gap are NOT in newFills.` }),
    };
  }

  const newCursor = saveSnap(chain, wallet, nowSnap);

  // A zero-row read is a ZERO-INFORMATION read (BUG: buyer desk paid 75x for txsFetched:0 on a
  // wallet with real on-chain activity). The market API returns the same empty list for "no DEX
  // fills" and "chain/wallet not indexed" — indistinguishable from here, so it is disclosed and,
  // under the billing contract (ok:false = not a delivered answer), FREE. Cursor semantics survive.
  const emptyRead = txs.length === 0
    ? {
        ok: false,
        verdict: 'NO_DATA',
        coverageNote: `Zero transactions came back for this wallet on ${chain}. This service reads DEX fills indexed by the market API; an empty read can mean EITHER no DEX activity for this wallet OR a chain/wallet the index does not cover — the API does not distinguish, so this call is free. Plain token transfers, x402 payments and CEX orders are NOT DEX fills and will never appear in this digest.`,
      }
    : {};

  return {
    service: 'loop-digest',
    version: config.version,
    ...emptyRead,
    chain, wallet,
    cursor: newCursor,
    cursorStatus: cursorKnown ? 'diffed' : cursor ? 'unknown-rebaselined' : 'baseline-stored',
    baseline: !diff,
    diff: diff || {
      note: cursor
        ? 'Your cursor was NOT FOUND (expired after 24h, or the service instance restarted — cursors are in-memory). A fresh baseline was stored; the diff between your old cursor and now is LOST, not empty.'
        : 'First call for this wallet (no prior cursor) — baseline stored. Pass this response\'s cursor next call to get only what changed.',
    },
    historyWindow: { txsFetched: txs.length, newestTxTime: lastTxTime || null, oldestTxTime: oldestTxTime || null },
    positionsTracked: Object.keys(curState).length,
    method: 'Cursor-based state diff: stores a per-call snapshot (last fill time + per-token PnL) and, given the prior cursor, returns only new fills and PnL drift since then — a compact loop-top read instead of a full re-fetch. cursorStatus + diffComplete disclose continuity: an unknown cursor or a history window that does not span the cursor is said out loud, never silently rebaselined.',
    limitations: 'Diff is relative to the cursor you pass; snapshots are in-memory and expire after 24h (and do not survive service restarts — disclosed via cursorStatus). Covers DEX fills and per-token PnL as reported by the market API; diffComplete=false means the fetch window may hide fills in the gap.',
    elapsedMs: Date.now() - t0,
  };
}
