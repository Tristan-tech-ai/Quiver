// SIGNATURE-X — the blind spot every tx simulator has.
//
// Modern wallet drainers overwhelmingly do NOT ask you to send a transaction. They ask you to SIGN an
// EIP-712 typed message (eth_signTypedData_v4) — gasless, nothing in your activity feed, disguised as a
// "login", "captcha", "wallet connect" or "NFT mint" prompt. The drainer then redeems that signature
// on-chain itself. Because there is no transaction, a simulator (ours included) is STRUCTURALLY blind:
// there is nothing to simulate. Documented: ~$1.77M USDC drained from one wallet via an EIP-2612 permit
// signature, redeemed through an EIP-7702-delegated address.
//
// Type strings are taken VERBATIM from the canonical source (Uniswap/permit2 src/libraries/PermitHash.sol)
// — note Permit2 amounts are uint160 (unlimited sentinel 2^160−1), NOT uint256; using the wrong constant
// silently fails to detect the exact thing this exists to catch. EIP-2612 uses uint256.
//   PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)
//   PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)
//   PermitBatch(PermitDetails[] details,address spender,uint256 sigDeadline)
//   PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)
//   TokenPermissions(address token,uint256 amount)
//   EIP-2612: Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)
import { config } from '../config.js';
import { resolveSpender } from './calldataX.js';
import * as evm from '../adapters/evmrpc.js';

const MAX_U160 = (2n ** 160n) - 1n;
const MAX_U256 = (2n ** 256n) - 1n;
const MAX_U48 = (2n ** 48n) - 1n;
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const DAY = 86400;

const big = (x) => { try { return BigInt(String(x)); } catch { return null; } };
const shortAddr = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '—');
const fmtAmt = (v, dec) => { if (v == null) return '?'; const d = 10n ** BigInt(dec); const w = v / d, f = v % d; return `${w}${f ? '.' + f.toString().padStart(dec, '0').replace(/0+$/, '').slice(0, 4) : ''}`; };

// Normalise any supported permit shape into a common list of grants.
function parse(td) {
  const primary = td.primaryType;
  const m = td.message || {};
  const dom = td.domain || {};
  const g = [];
  if (primary === 'PermitSingle' && m.details) {
    g.push({ token: m.details.token, amount: big(m.details.amount), width: 160, expiration: big(m.details.expiration), spender: m.spender, sigDeadline: big(m.sigDeadline) });
    return { kind: 'Permit2 PermitSingle', grants: g, spender: m.spender, permit2: true };
  }
  if (primary === 'PermitBatch' && Array.isArray(m.details)) {
    for (const d of m.details) g.push({ token: d.token, amount: big(d.amount), width: 160, expiration: big(d.expiration), spender: m.spender, sigDeadline: big(m.sigDeadline) });
    return { kind: 'Permit2 PermitBatch', grants: g, spender: m.spender, permit2: true };
  }
  if (primary === 'PermitTransferFrom' && m.permitted) {
    g.push({ token: m.permitted.token, amount: big(m.permitted.amount), width: 256, expiration: big(m.deadline), spender: m.spender, sigDeadline: big(m.deadline) });
    return { kind: 'Permit2 PermitTransferFrom', grants: g, spender: m.spender, permit2: true };
  }
  if (primary === 'PermitBatchTransferFrom' && Array.isArray(m.permitted)) {
    for (const p of m.permitted) g.push({ token: p.token, amount: big(p.amount), width: 256, expiration: big(m.deadline), spender: m.spender, sigDeadline: big(m.deadline) });
    return { kind: 'Permit2 PermitBatchTransferFrom', grants: g, spender: m.spender, permit2: true };
  }
  if (primary === 'Permit' && m.spender !== undefined && m.value !== undefined) {
    // EIP-2612: the TOKEN itself is the verifying contract.
    g.push({ token: dom.verifyingContract, amount: big(m.value), width: 256, expiration: big(m.deadline), spender: m.spender, sigDeadline: big(m.deadline) });
    return { kind: 'EIP-2612 Permit', grants: g, spender: m.spender, permit2: false, owner: m.owner };
  }
  return null;
}

const isUnlimited = (amt, width) => amt != null && (width === 160 ? amt >= MAX_U160 : amt >= MAX_U256 - (2n ** 128n));
const neverExpires = (exp) => exp != null && (exp >= MAX_U48 || exp === 0n || exp > BigInt(Math.floor(Date.now() / 1000) + 3650 * DAY));

export async function signatureX({ typedData, chain = 'ethereum' }) {
  const t0 = Date.now();
  let td;
  try { td = typeof typedData === 'string' ? JSON.parse(typedData) : typedData; } catch { td = null; }
  if (!td || typeof td !== 'object' || !td.primaryType) {
    return { service: 'signature-x', version: config.version, verdict: 'INVALID', note: 'Provide an EIP-712 typed-data object (the exact payload from eth_signTypedData_v4), with domain, types, primaryType and message.' };
  }
  const parsed = parse(td);
  const dom = td.domain || {};
  if (!parsed) {
    return {
      service: 'signature-x', version: config.version, primaryType: td.primaryType,
      verdict: 'UNRECOGNISED_SIGNATURE',
      alert: { level: 'CAUTION', headline: `This is an off-chain signature of type "${td.primaryType}" that is not a known token-permit shape. It is NOT a transaction — nothing will appear in your wallet activity — but a signature can still authorise actions. Only sign if you understand exactly what "${td.primaryType}" does on ${dom.name || 'this contract'}.` },
      domain: dom,
      method: 'EIP-712 typed-data analysis. Recognised shapes: Permit2 PermitSingle/PermitBatch/PermitTransferFrom/PermitBatchTransferFrom and EIP-2612 Permit.',
      elapsedMs: Date.now() - t0,
    };
  }

  // Resolve the spender's reputation with the SAME logic the calldata simulator uses.
  const rep = await resolveSpender(chain, parsed.spender).catch(() => ({ tier: 'unknown', name: null }));

  // Humanise tokens (symbol/decimals on-chain).
  const tokens = [...new Set(parsed.grants.map((g) => String(g.token || '').toLowerCase()).filter((t) => /^0x[0-9a-f]{40}$/.test(t)))].slice(0, 6);
  const meta = {};
  await Promise.all(tokens.map(async (t) => { meta[t] = await evm.erc20Meta(chain, t).catch(() => ({ symbol: null, decimals: 18 })); }));

  const flags = [];
  const grants = parsed.grants.map((g) => {
    const mt = meta[String(g.token || '').toLowerCase()] || { symbol: null, decimals: 18 };
    const unl = isUnlimited(g.amount, g.width);
    const forever = neverExpires(g.expiration);
    return {
      token: g.token, symbol: mt.symbol,
      amount: unl ? 'UNLIMITED' : fmtAmt(g.amount, mt.decimals ?? 18),
      unlimited: unl,
      expiresUtc: g.expiration != null && g.expiration > 0n && g.expiration < MAX_U48 ? new Date(Number(g.expiration) * 1000).toISOString() : null,
      neverExpires: forever,
    };
  });

  const anyUnlimited = grants.some((g) => g.unlimited);
  const anyForever = grants.some((g) => g.neverExpires);
  const multi = grants.length > 1;

  // Domain integrity: a Permit2-shaped message MUST be verified by the canonical Permit2 contract.
  const domainOk = !parsed.permit2 || String(dom.verifyingContract || '').toLowerCase() === PERMIT2;
  if (!domainOk) flags.push({ level: 'high', flag: 'SPOOFED_PERMIT2_DOMAIN', detail: `This message uses Permit2's structure but asks you to sign it against ${dom.verifyingContract} — NOT the real Permit2 contract (${PERMIT2}). That is a forgery pattern.` });
  if (anyUnlimited) flags.push({ level: rep.tier === 'known' ? 'low' : 'high', flag: 'UNLIMITED_PERMIT', detail: 'The signature authorises an UNLIMITED token amount.' });
  if (anyForever) flags.push({ level: 'high', flag: 'NEVER_EXPIRES', detail: 'The permission has no practical expiry — it stays live indefinitely.' });
  if (multi) flags.push({ level: rep.tier === 'known' ? 'low' : 'high', flag: 'BATCH_MULTI_TOKEN', detail: `ONE signature authorises ${grants.length} different tokens at once.` });
  if (rep.delegated) flags.push({ level: 'high', flag: 'SPENDER_IS_7702_DELEGATED_WALLET', detail: 'The spender is a wallet with EIP-7702 delegated code — the exact pattern used in documented permit-phishing drains.' });
  else if (rep.tier === 'eoa') flags.push({ level: 'high', flag: 'SPENDER_IS_A_WALLET', detail: 'The spender is a plain wallet (EOA), not a contract. Legitimate permits are granted to protocol contracts.' });

  const who = rep.tier === 'known' ? `${rep.name} (${shortAddr(parsed.spender)}), a known protocol contract` : rep.delegated ? `${shortAddr(parsed.spender)} — a WALLET with EIP-7702 delegated code` : rep.tier === 'eoa' ? `${shortAddr(parsed.spender)} — a personal WALLET, not a contract` : rep.tier === 'contract' ? `${shortAddr(parsed.spender)}, a contract we cannot verify as a known protocol` : `${shortAddr(parsed.spender)} (reputation unverifiable right now)`;
  const what = anyUnlimited ? `UNLIMITED ${grants.map((g) => g.symbol || 'tokens').join(', ')}` : grants.map((g) => `${g.amount} ${g.symbol || 'tokens'}`).join(', ');

  const danger = !domainOk || rep.tier === 'eoa' || rep.delegated || (anyUnlimited && rep.tier !== 'known') || (anyForever && rep.tier !== 'known');
  const routine = rep.tier === 'known' && domainOk;

  const alert = danger ? {
    level: 'DANGER',
    headline: `🚨 DO NOT SIGN — this grants ${what} to ${who}${anyForever ? ', with no expiry' : ''}. This is NOT a transaction: it costs no gas and will not show in your wallet's activity, so it looks harmless — but the signature alone lets that address take those tokens whenever it chooses.`,
  } : routine ? {
    level: 'NOTE',
    headline: `Routine: this authorises ${what} to ${rep.name} — a known protocol contract, verified against the real Permit2 domain. This is the standard gasless approval DeFi apps use. You can revoke it, and ${grants.some((g) => g.expiresUtc) ? 'it expires on its own.' : 'it should carry an expiry.'}`,
  } : {
    level: 'CAUTION',
    headline: `⚠️ This grants ${what} to ${who}. It is a signature, not a transaction — no gas, no activity-feed entry — but it is still a real authorisation. Only sign if you specifically trust that address.`,
  };

  return {
    service: 'signature-x',
    version: config.version,
    chain, signatureType: parsed.kind, primaryType: td.primaryType,
    verdict: alert.level === 'DANGER' ? 'DO_NOT_SIGN' : alert.level === 'CAUTION' ? 'REVIEW' : 'ROUTINE',
    alert,
    spender: { address: parsed.spender, reputation: rep.tier, name: rep.name || null, eip7702Delegated: !!rep.delegated },
    grants,
    domainVerified: domainOk,
    domain: { name: dom.name || null, chainId: dom.chainId ?? null, verifyingContract: dom.verifyingContract || null },
    riskFlags: flags,
    whyThisMatters: 'A transaction simulator cannot see this. Signature-based permits are the dominant modern drain vector precisely because they are gasless and invisible to tx-level tooling — there is no transaction to simulate until the attacker redeems your signature themselves.',
    provenance: {
      sources: 'EIP-712 typed data as supplied; Permit2 struct definitions taken verbatim from Uniswap/permit2 (src/libraries/PermitHash.sol); spender reputation from an allowlist of known protocol contracts plus a live eth_getCode class check (contract / EOA / EIP-7702-delegated).',
      reCheck: `Verify the spender yourself: eth_getCode(${parsed.spender}) — empty means it is a wallet, not a contract. Verify the domain: a genuine Permit2 message is always verified by ${PERMIT2}.`,
    },
    method: 'Decodes an EIP-712 permit signature request (Permit2 PermitSingle/PermitBatch/PermitTransferFrom or EIP-2612 Permit), resolves the exact tokens, amounts and expiries it authorises, checks the EIP-712 domain against the canonical Permit2 contract, and classifies the spender (known protocol / unverified contract / wallet / EIP-7702-delegated wallet) to judge real risk rather than the allowance number alone.',
    limitations: 'Covers the permit shapes above; an unrecognised primaryType is flagged rather than judged. Reputation rests on a curated allowlist plus code-type — an unknown contract is reported as unverified, never as safe. Not financial advice.',
    elapsedMs: Date.now() - t0,
  };
}
