// CalldataX — one call: decode raw calldata / an unsigned tx into a human verdict:
// function, arguments, plain-English intent, and risk flags (unlimited approval, setApprovalForAll,
// ownership transfer, unknown selector). "Never sign what you cannot explain."
import { ethers } from 'ethers';
import { config } from '../config.js';
import * as evm from '../adapters/evmrpc.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const addrOf = (topic) => '0x' + String(topic).slice(26);
const uintOf = (hex) => { try { return BigInt(hex); } catch { return 0n; } };
const fmtAmt = (v, dec) => { const d = BigInt(10) ** BigInt(dec); const w = v / d, f = v % d; return `${w}${f ? '.' + f.toString().padStart(dec, '0').replace(/0+$/, '').slice(0, 6) : ''}`; };

// Simulate the tx and decode Transfer/Approval logs into net asset + approval changes for `from`.
async function simulateTx(chain, { from, to, data, value }) {
  const sim = await evm.simulate(chain, { from, to, data, value: value && value !== '0' ? '0x' + BigInt(value).toString(16) : '0x0' });
  const reverted = sim.status === '0x0' || !!sim.error;
  const net = {}; // token -> {inn, out}
  const approvals = [];
  const fromL = String(from).toLowerCase();
  for (const log of sim.logs || []) {
    const t0 = (log.topics || [])[0];
    const token = String(log.address).toLowerCase();
    if (t0 === TRANSFER && log.topics.length >= 3) {
      const f = addrOf(log.topics[1]).toLowerCase(), t = addrOf(log.topics[2]).toLowerCase();
      const amt = uintOf(log.data);
      if (f === fromL || t === fromL) {
        net[token] = net[token] || { inn: 0n, out: 0n };
        if (t === fromL) net[token].inn += amt;
        if (f === fromL) net[token].out += amt;
      }
    } else if (t0 === APPROVAL && log.topics.length >= 3) {
      const owner = addrOf(log.topics[1]).toLowerCase();
      if (owner === fromL) approvals.push({ token, spender: addrOf(log.topics[2]), amount: uintOf(log.data) });
    }
  }
  // humanize involved tokens
  const involved = [...new Set([...Object.keys(net), ...approvals.map((a) => a.token)])].slice(0, 8);
  const meta = {};
  await Promise.all(involved.map(async (tk) => { meta[tk] = await evm.erc20Meta(chain, tk).catch(() => ({ symbol: null, decimals: 18 })); }));
  const MAXISH = (2n ** 256n - 1n) - (2n ** 128n);
  const assetChanges = Object.entries(net).map(([tk, v]) => {
    const m = meta[tk] || { decimals: 18 }; const delta = v.inn - v.out;
    return { token: tk, symbol: m.symbol, direction: delta > 0n ? 'IN' : delta < 0n ? 'OUT' : 'NET_ZERO', amount: fmtAmt(delta < 0n ? -delta : delta, m.decimals) };
  }).filter((a) => a.direction !== 'NET_ZERO');
  const approvalChanges = approvals.map((a) => { const m = meta[a.token] || { decimals: 18 }; return { token: a.token, symbol: m.symbol, spender: a.spender, amount: a.amount >= MAXISH ? 'UNLIMITED' : fmtAmt(a.amount, m.decimals) }; });
  // Gas cost (D9): the simulation returns gasUsed; price it with the live gas price for a native-token fee.
  let gas = null;
  const gasUsed = sim.gasUsed != null ? (() => { try { return BigInt(sim.gasUsed); } catch { return null; } })() : null;
  if (gasUsed != null && !reverted) {
    const gp = await evm.gasPrice(chain).catch(() => null);
    gas = {
      gasUsed: Number(gasUsed),
      gasPriceGwei: gp != null ? Math.round(Number(gp) / 1e7) / 100 : null,
      estimatedFeeNative: gp != null ? Number(gasUsed * gp) / 1e18 : null,
      nativeSymbol: NATIVE[String(chain).toLowerCase()] || 'ETH',
    };
  }
  // Evidence bundle (opening #3): pin the state the sim ran against + emit each observed effect as a
  // re-checkable assertion, so a caller can defend a signing decision to a third party. eth_simulateV1 runs
  // ON TOP OF 'latest'; the base state = the block just before the simulated block. Pin its hash so the
  // whole thing is reproducible — re-run eth_simulateV1 against that base and the deltas must reproduce.
  let baseBlock = null;
  try {
    if (sim.blockNumber != null) baseBlock = await evm.getBlock(chain, sim.blockNumber - 1);
    if (!baseBlock) baseBlock = await evm.getBlock(chain, 'latest');
  } catch { /* evidence is best-effort; absence is disclosed below */ }
  const evidenceBundle = buildEvidenceBundle({ from, to, data, value }, { blockNumber: sim.blockNumber ?? null, assetChanges, approvalChanges }, baseBlock);
  return { rpc: sim.rpc, blockNumber: sim.blockNumber ?? null, blockHash: sim.blockHash ?? null, reverted, revertError: sim.error || null, assetChanges, approvalChanges, gas, evidenceBundle };
}

// Assemble the auditable evidence bundle (pure — no I/O). Each observed effect becomes a re-checkable
// assertion; the base block pins the state so a third party can re-run eth_simulateV1 and reproduce every
// claim. Absence of a pinnable base block is DISCLOSED, never silently dropped.
export function buildEvidenceBundle(call, sim, baseBlock) {
  const assertions = [
    ...(sim.assetChanges || []).map((a) => ({ kind: 'asset-delta', claim: `${a.direction === 'OUT' ? 'sends' : a.direction === 'IN' ? 'receives' : 'nets'} ${a.amount} ${a.symbol || a.token} ${a.direction}`, token: a.token, direction: a.direction, amount: a.amount })),
    ...(sim.approvalChanges || []).map((a) => ({ kind: 'approval', claim: `grants ${a.spender} a ${a.amount} allowance on ${a.symbol || a.token}`, token: a.token, spender: a.spender, amount: a.amount })),
  ];
  const v = call.value;
  return {
    pinnedState: baseBlock ? { baseBlockNumber: baseBlock.number, baseBlockHash: baseBlock.hash } : { note: 'base-block hash unavailable this call — the sim ran but the state pin could not be fetched; deltas are still observed, just not block-pinned.' },
    simulatedBlockNumber: sim.blockNumber ?? null,
    method: 'eth_simulateV1',
    call: { from: call.from, to: call.to, data: (call.data || '').slice(0, 10) + '…', valueWei: v && v !== '0' ? '0x' + BigInt(v).toString(16) : '0x0' },
    assertions,
    assertionCount: assertions.length,
    reCheck: baseBlock
      ? `Re-run eth_simulateV1 with these exact {from,to,data,value} against base block ${baseBlock.number} (hash ${baseBlock.hash}); every assertion above must reproduce. If the base block hash has since been re-orged, re-pin to the new canonical block.`
      : 'Re-run eth_simulateV1 with the same {from,to,data,value} on current state; note the base block was not pinnable this call.',
  };
}

const FOURBYTE = 'https://www.4byte.directory/api/v1/signatures/?hex_signature=';
const MAX_UINT = (2n ** 256n - 1n);
const KNOWN = {
  '0x095ea7b3': 'approve(address,uint256)',
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0xa22cb465': 'setApprovalForAll(address,bool)',
  '0x42842e0e': 'safeTransferFrom(address,address,uint256)',
  '0x2e1a7d4d': 'withdraw(uint256)',
  '0xd0e30db0': 'deposit()',
  '0xf2fde38b': 'transferOwnership(address)',
  '0x39509351': 'increaseAllowance(address,uint256)',
  '0x7ff36ab5': 'swapExactETHForTokens(uint256,address[],address,uint256)',
  '0x38ed1739': 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
};

async function lookupSelector(selector) {
  if (KNOWN[selector]) return [KNOWN[selector]];
  try {
    const r = await fetch(FOURBYTE + selector, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const j = await r.json();
    // prefer the earliest id (least likely to be a spoofed collision)
    return (j.results || []).sort((a, b) => a.id - b.id).map((x) => x.text_signature);
  } catch { return []; }
}

function riskFlags(fnName, args) {
  const flags = [];
  if (/^approve\(/.test(fnName) && args.length >= 2) {
    const amt = BigInt(args[1].value ?? 0);
    if (amt >= MAX_UINT) flags.push({ level: 'high', flag: 'UNLIMITED_APPROVAL', detail: 'Grants unlimited token spending allowance to the spender — they can move all of this token from your wallet, indefinitely.' });
    else if (amt > 10n ** 30n) flags.push({ level: 'medium', flag: 'VERY_LARGE_APPROVAL', detail: 'Approval amount is extremely large.' });
  }
  if (/^setApprovalForAll\(/.test(fnName) && args[1]?.value === true) flags.push({ level: 'high', flag: 'APPROVE_ALL_NFTS', detail: 'Grants control over ALL your NFTs in this collection to the operator.' });
  if (/^transferOwnership\(/.test(fnName)) flags.push({ level: 'high', flag: 'OWNERSHIP_TRANSFER', detail: 'Transfers contract ownership.' });
  return flags;
}

const shortAddr = (a) => (a && /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || 'the spender'));

// Allowlist of well-known, reputable spenders (lowercased). Unlimited approval to these is ROUTINE,
// not a drainer signal — they are audited, widely-used routers/protocols. Addresses are canonical
// (CREATE2/known deployments), effectively chain-agnostic for the ones listed.
const KNOWN_SPENDERS = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 SwapRouter',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 SwapRouter02',
  '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Uniswap Universal Router',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'Uniswap Universal Router',
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Uniswap Permit2',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch Aggregation Router V5',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch Aggregation Router V6',
  '0x1111111254fb6c44bac0bed2854e76f90643097d': '1inch Aggregation Router V4',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
  '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110': 'CoW Protocol VaultRelayer',
  '0x216b4b4ba9f3e719726886d34a177484278bfcae': 'Paraswap TokenTransferProxy',
  '0x881d40237659c251811cec9c364ef91dc08d300c': 'MetaMask Swap Router',
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'KyberSwap MetaAggregationRouter V2',
};
const KNOWN_NFT_OPERATORS = {
  '0x00000000000000adc04c56bf30ac9d3c0aaf14dc': 'OpenSea Seaport 1.5',
  '0x0000000000000068f116a894984e2db1123eb395': 'OpenSea Seaport 1.6',
  '0x00000000000111abe46ff893f3b2fdf1f759a8a8': 'Blur Execution Delegate',
  '0x1e0049783f008a0085193e00003d00cd54003c71': 'OpenSea Conduit',
};

// contract vs EOA — in the EIP-7702 era, a delegated EOA carries 23 bytes of 0xef0100 code and is
// still fundamentally a wallet, so detect it separately from a real contract.
function codeType(code) {
  if (code == null) return 'unknown';                       // RPC failed → can't determine
  const c = String(code).toLowerCase();
  if (c === '0x' || c === '0x0' || c.length <= 2) return 'eoa';
  if (c.startsWith('0xef0100')) return 'eoa7702';           // EIP-7702 delegated wallet
  return 'contract';
}

// EIP-1967 storage slots (keccak256('eip1967.proxy.*')−1). A non-zero implementation/beacon slot means the
// address is an UPGRADEABLE PROXY: the logic behind it can be swapped by its admin AFTER you approve it, so
// an audit of today's code is not binding. This is a real, under-surfaced approval risk (D10).
const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
// Legacy OpenZeppelin/zeppelinos implementation slot — used by early proxies deployed BEFORE EIP-1967,
// notably USDC's FiatTokenProxy. Ground-truth caught that EIP-1967-only detection wrongly calls USDC
// "not a proxy"; this slot closes that gap.
const ZOS_IMPL = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
async function detectProxy(chain, addr) {
  const slot = async (s) => { const v = await evm.storageAt(chain, addr, s).catch(() => null); if (!v) return null; try { return BigInt(v) === 0n ? null : '0x' + v.slice(-40); } catch { return null; } };
  const impl = await slot(EIP1967_IMPL);
  if (impl) return { isProxy: true, standard: 'EIP-1967 (upgradeable)', implementation: impl };
  const beacon = await slot(EIP1967_BEACON);
  if (beacon) return { isProxy: true, standard: 'EIP-1967 beacon (upgradeable)', beacon };
  const zos = await slot(ZOS_IMPL);
  if (zos) return { isProxy: true, standard: 'legacy OpenZeppelin/zeppelinos (upgradeable)', implementation: zos };
  return { isProxy: false };
}

// Native gas token per chain (for pricing a simulated tx's fee).
const NATIVE = { ethereum: 'ETH', base: 'ETH', arbitrum: 'ETH', optimism: 'ETH', bsc: 'BNB', polygon: 'POL' };

// Resolve a spender's reputation from reliable, reachable signals: allowlist first, then eth_getCode, plus
// a cheap on-chain ACTIVITY/AGE signal (D11): code size for contracts, outbound-tx count for wallets, and
// EIP-1967 proxy status for contracts. Deeper reputation (verified source, first-seen age, approval graph)
// needs an indexer/explorer key that isn't wired here — disclosed, not faked.
// Exported so the EIP-712 signature analyzer reuses the SAME reputation logic (one source of truth).
export async function resolveSpender(chain, addr, isNft = false) {
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return { addr, tier: 'unknown', name: null };
  const key = addr.toLowerCase();
  const list = isNft ? KNOWN_NFT_OPERATORS : KNOWN_SPENDERS;
  if (list[key]) return { addr, tier: 'known', name: list[key] };
  if (!isNft && KNOWN_NFT_OPERATORS[key]) return { addr, tier: 'known', name: KNOWN_NFT_OPERATORS[key] };
  const codeHex = await evm.code(chain, addr).catch(() => null);
  const ct = codeType(codeHex);
  const codeSizeBytes = codeHex && codeHex.length > 2 ? (codeHex.length - 2) / 2 : 0;
  const activity = {};
  if (ct === 'contract') { activity.codeSizeBytes = codeSizeBytes; const px = await detectProxy(chain, addr).catch(() => null); if (px) activity.proxy = px; }
  if (ct === 'eoa' || ct === 'eoa7702') { const nonce = await evm.txCount(chain, addr).catch(() => null); if (nonce != null) activity.outboundTxCount = nonce; }
  return { addr, tier: ct === 'contract' ? 'contract' : ct === 'unknown' ? 'unknown' : 'eoa', name: null, delegated: ct === 'eoa7702', activity };
}

// ONE-GLANCE danger verdict a non-expert reads instantly, keyed on spender REPUTATION × effect —
// not the allowance number alone. rep = { tier: known|contract|eoa|unknown, name, delegated }.
// simConfirmed = we simulated on the real chain (so an EOA verdict is trustworthy, not a wrong-chain guess).
function buildAlert(flags, simulation, args, decodedName, to, rep, simConfirmed) {
  const has = (f) => flags.some((x) => x.flag === f);
  const simApprovals = (simulation && simulation.approvalChanges) || [];
  const unlimitedSim = simApprovals.find((a) => a.amount === 'UNLIMITED');
  const outflow = (simulation && simulation.assetChanges || []).find((a) => a.direction === 'OUT');

  if (has('UNLIMITED_APPROVAL')) {
    const spender = unlimitedSim?.spender || args[0]?.value || rep?.addr || null;
    const sym = unlimitedSim?.symbol || null;
    const t = rep?.tier || 'unknown';
    if (t === 'known') {
      return { level: 'NOTE', headline: `🔵 Routine — this grants an unlimited ${sym || 'token'} approval to ${rep.name} (${shortAddr(spender)}), a well-known DeFi router. This is the standard allowance such routers request to trade on your behalf; no funds move now, and you can revoke it anytime.`, action: `Expected if you're using ${rep.name}. If you didn't initiate a swap/approval there, don't sign.` };
    }
    if (t === 'eoa') {
      const lvl = simConfirmed ? 'DANGER' : 'CAUTION';
      return { level: lvl, headline: `${lvl === 'DANGER' ? '🚨 DANGER' : '⚠️ CAUTION'} — this grants an UNLIMITED ${sym || 'token'} approval to ${shortAddr(spender)}, which is a ${rep.delegated ? 'delegated wallet (EIP-7702)' : 'wallet (EOA)'} — NOT a smart contract. Legitimate approvals go to audited protocol contracts; an unlimited grant to a personal address is the hallmark of an approval-drainer scam. It could move ALL of your ${sym || 'tokens'} until revoked.`, action: `Do NOT sign. There is almost no legitimate reason to give a wallet address an unlimited token allowance.` };
    }
    // unknown / unverified contract
    return { level: 'CAUTION', headline: `⚠️ CAUTION — this grants an UNLIMITED ${sym || 'token'} approval to ${shortAddr(spender)}, a contract we could NOT verify as a known router or protocol${t === 'unknown' ? " (couldn't check its code right now)" : ''}. New/unknown protocols use this pattern, but so do drainers — an unlimited allowance lets it move all of this token until revoked.`, action: `Only sign if you specifically trust ${shortAddr(spender)}. Prefer approving just the amount you need.` };
  }
  if (has('APPROVE_ALL_NFTS')) {
    const op = args[0]?.value;
    const t = rep?.tier || 'unknown';
    if (t === 'known') return { level: 'NOTE', headline: `🔵 Routine — this grants NFT operator approval to ${rep.name} (${shortAddr(op)}), a recognized NFT marketplace. This is the standard approval needed to list/trade your NFTs there; revocable anytime.`, action: `Expected if you're listing on ${rep.name}. If not, don't sign.` };
    const lvl = (t === 'eoa' && simConfirmed) ? 'DANGER' : t === 'eoa' ? 'CAUTION' : 'CAUTION';
    return { level: lvl, headline: `${lvl === 'DANGER' ? '🚨 DANGER' : '⚠️ CAUTION'} — this hands control of ALL your NFTs in this collection to ${shortAddr(op)}${t === 'eoa' ? ', a wallet (EOA), not a marketplace contract' : ', which we could not verify as a known marketplace'}. They could transfer every NFT out of your wallet. This is a common NFT-drainer pattern.`, action: `Do NOT sign unless you specifically trust ${shortAddr(op)}.` };
  }
  if (has('OWNERSHIP_TRANSFER')) {
    return { level: 'DANGER', headline: `🚨 DANGER — This transfers CONTRACT OWNERSHIP to ${shortAddr(args[0]?.value)}. Whoever owns the contract controls it.`, action: 'Only sign if you intend to hand over full control of this contract.' };
  }
  if (has('WOULD_REVERT')) {
    return { level: 'CAUTION', headline: '⚠️ This transaction would REVERT (fail) when simulated against live chain state — it will not do what it claims and wastes gas.', action: 'Check the inputs; do not broadcast as-is.' };
  }
  if (outflow) {
    return { level: 'CAUTION', headline: `⚠️ This sends ${outflow.amount} ${outflow.symbol || 'tokens'} OUT of your wallet (confirmed by simulation).`, action: 'Confirm the recipient and amount are exactly what you intend.' };
  }
  if (has('VERY_LARGE_APPROVAL')) {
    const t = rep?.tier || 'unknown';
    if (t === 'known') return { level: 'NOTE', headline: `🔵 A very large ${to ? '' : ''}approval to ${rep.name} (${shortAddr(args[0]?.value)}), a known router — effectively unlimited but to a reputable spender.`, action: 'Expected for routine DeFi use; revoke anytime.' };
    return { level: 'CAUTION', headline: `⚠️ This approves an extremely large (effectively unlimited) amount to ${shortAddr(args[0]?.value)}, a spender we couldn't verify as a known router.`, action: 'Prefer approving only the amount you need.' };
  }
  if (flags.some((f) => f.level === 'high')) return { level: 'DANGER', headline: `🚨 DANGER — ${flags.find((f) => f.level === 'high').detail}`, action: 'Do not sign without fully understanding this transaction.' };
  if (flags.length) return { level: 'CAUTION', headline: `⚠️ ${flags[0].detail}`, action: 'Review carefully before signing.' };
  if (simulation && simulation.available !== false) return { level: 'SAFE', headline: `✅ No dangerous approvals or unexpected outflows detected in this ${decodedName ? decodedName + '()' : ''} transaction, as simulated on live chain state.`, action: 'Looks routine — still confirm the destination is the one you intend.' };
  return { level: 'INFO', headline: `Decoded ${decodedName ? decodedName + '()' : 'the calldata'}. Provide "to" and "from" to simulate the real asset & approval effects before signing.`, action: 'Simulation gives the strongest safety signal.' };
}

export async function calldataX({ data, value = '0', to = null, from = null, chain = 'ethereum' }) {
  const t0 = Date.now();
  const hex = String(data).trim();
  if (!/^0x[0-9a-fA-F]{8,}$/.test(hex)) {
    return { service: 'calldata-x', version: config.version, verdict: 'INVALID', note: 'Provide hex calldata starting with 0x and at least a 4-byte selector.' };
  }
  const selector = hex.slice(0, 10).toLowerCase();
  const sigs = await lookupSelector(selector);
  if (!sigs.length) {
    return {
      service: 'calldata-x', version: config.version, selector,
      alert: { level: 'CAUTION', headline: `⚠️ Unknown function — selector ${selector} matches no public signature registry. You cannot know what signing this does.`, action: 'Treat unknown calldata as untrusted; do not sign without an independent explanation.' },
      verdict: 'UNKNOWN_SELECTOR',
      note: 'The 4-byte function selector is not in any known signature registry. Treat unknown calldata as untrusted — do not sign without understanding it.',
      riskFlags: [{ level: 'medium', flag: 'UNKNOWN_FUNCTION', detail: 'Function could not be identified.' }],
      elapsedMs: Date.now() - t0,
    };
  }

  // Try each candidate signature until one decodes cleanly.
  let decoded = null, usedSig = null;
  for (const sig of sigs.slice(0, 6)) {
    try {
      const iface = new ethers.Interface([`function ${sig}`]);
      const parsed = iface.parseTransaction({ data: hex, value: BigInt(value || 0) });
      if (parsed) {
        decoded = parsed; usedSig = sig; break;
      }
    } catch { /* try next candidate */ }
  }
  if (!decoded) {
    return { service: 'calldata-x', version: config.version, selector, candidateSignatures: sigs.slice(0, 4), verdict: 'UNDECODABLE', note: 'Selector matched known signatures but the argument data did not decode against any of them (possible spoofed selector or truncated data).', elapsedMs: Date.now() - t0 };
  }

  const args = decoded.fragment.inputs.map((inp, i) => {
    let v = decoded.args[i];
    if (typeof v === 'bigint') v = v.toString();
    else if (Array.isArray(v)) v = v.map((x) => (typeof x === 'bigint' ? x.toString() : x));
    return { name: inp.name || `arg${i}`, type: inp.type, value: v };
  });
  const flags = riskFlags(decoded.name + '(', args);
  const nativeValue = BigInt(value || 0);

  // Real on-chain SIMULATION when we have the full unsigned tx (to + from). Shows exact
  // asset and approval changes the signer would incur — not just the decoded intent.
  let simulation = null;
  if (to && from) {
    try {
      simulation = await simulateTx(chain, { from, to, data: hex, value: nativeValue.toString() });
      if (simulation.reverted) flags.push({ level: 'medium', flag: 'WOULD_REVERT', detail: 'Simulating this transaction reverts — it would fail on-chain (wastes gas; not a funds-drain risk).' });
      for (const a of simulation.approvalChanges) if (a.amount === 'UNLIMITED') { if (!flags.some((f) => f.flag === 'UNLIMITED_APPROVAL')) flags.push({ level: 'high', flag: 'UNLIMITED_APPROVAL', detail: `Simulation confirms an unlimited ${a.symbol || 'token'} approval to ${a.spender}.` }); }
      const bigOut = simulation.assetChanges.find((a) => a.direction === 'OUT');
      if (bigOut && !flags.length) flags.push({ level: 'medium', flag: 'ASSET_OUTFLOW', detail: `Sends ${bigOut.amount} ${bigOut.symbol || 'tokens'} out of your wallet.` });
    } catch (e) {
      simulation = { error: String(e.message || e).slice(0, 160) };
    }
  }

  // Target-contract proxy check (D10): an upgradeable target can have its logic swapped by its admin AFTER
  // you interact, so today's decode/simulation is not binding on future behavior. Just a storage read.
  let targetProxy = null;
  if (to && /^0x[0-9a-fA-F]{40}$/.test(to)) {
    targetProxy = await detectProxy(chain, to).catch(() => null);
    if (targetProxy?.isProxy) flags.push({ level: 'low', flag: 'UPGRADEABLE_PROXY_TARGET', detail: `The target contract is an upgradeable ${targetProxy.standard} proxy — its admin can replace the logic behind it after you sign, so an audit of the current code is not binding.` });
  }

  const simAvailable = simulation && !simulation.error;
  const simObj = simAvailable ? { ...simulation, available: true } : { available: false };

  // Spender-reputation gate (Part B): the approval verdict keys on WHO gets the approval × the effect,
  // not the allowance number alone. Determine the spender, resolve its reputation, re-tier the flags.
  let rep = null, isNftOp = false, evalSpender = null;
  const simUnlimited = simAvailable && (simulation.approvalChanges || []).find((a) => a.amount === 'UNLIMITED');
  if (simUnlimited) evalSpender = simUnlimited.spender;
  else if (flags.some((f) => f.flag === 'UNLIMITED_APPROVAL' || f.flag === 'VERY_LARGE_APPROVAL')) evalSpender = args[0]?.value;
  if (decoded.name === 'setApprovalForAll' && args[1]?.value === true) { evalSpender = args[0]?.value; isNftOp = true; }
  if (evalSpender) rep = await resolveSpender(chain, evalSpender, isNftOp).catch(() => ({ addr: evalSpender, tier: 'unknown', name: null }));

  if (rep) {
    const uf = flags.find((f) => f.flag === 'UNLIMITED_APPROVAL');
    if (uf) {
      if (rep.tier === 'known') { uf.level = 'low'; uf.detail = `Unlimited approval to ${rep.name} — a recognized router; routine for DeFi and revocable anytime.`; }
      else if (rep.tier === 'eoa') { uf.level = simAvailable ? 'high' : 'medium'; uf.detail = `Unlimited approval to a ${rep.delegated ? 'delegated wallet (EIP-7702)' : 'wallet (EOA)'} — not a protocol contract; hallmark of a drainer.`; }
      else { uf.level = 'medium'; uf.detail = `Unlimited approval to an unverified contract (${shortAddr(rep.addr)}).`; }
    }
    const af = flags.find((f) => f.flag === 'APPROVE_ALL_NFTS');
    if (af) { af.level = rep.tier === 'known' ? 'low' : (rep.tier === 'eoa' && simAvailable) ? 'high' : 'medium'; if (rep.tier === 'known') af.detail = `Grants NFT operator approval to ${rep.name} — a recognized marketplace; routine.`; }
    const vf = flags.find((f) => f.flag === 'VERY_LARGE_APPROVAL');
    if (vf && rep.tier === 'known') vf.level = 'low';
  }

  const alert = buildAlert(flags, simObj, args, decoded.name, to, rep, simAvailable);
  const verdict = alert.level === 'DANGER' ? 'REVIEW_HIGH_RISK' : alert.level === 'CAUTION' ? 'REVIEW' : alert.level === 'NOTE' ? 'ROUTINE' : alert.level === 'SAFE' ? 'SAFE' : 'DECODED';

  // Re-checkable provenance (move 3): where every claim comes from + how to verify it independently.
  const provenance = simAvailable ? {
    basis: 'eth_simulateV1 — real execution against live chain state',
    rpc: simulation.rpc, blockNumber: simulation.blockNumber, chain,
    reconciledTo: 'asset & approval changes are read from the SIMULATED transaction\'s Transfer/Approval logs — not inferred from the input arguments',
    verify: `Re-run eth_simulateV1 with this exact {from,to,data,value} on any ${chain} node and compare the emitted Transfer(0xddf252ad…)/Approval(0x8c5be1e5…) logs.`,
  } : {
    basis: '4-byte selector + ABI decode (no simulation — "to"/"from" not provided)',
    reconciledTo: 'function identified via the public 4byte signature registry; risk inferred from decoded arguments',
    verify: `Decode selector ${selector} against "${usedSig}" and inspect the arguments; provide to+from to simulate the real effect.`,
  };

  return {
    service: 'calldata-x',
    version: config.version,
    selector, chain: to && from ? chain : undefined,
    alert,
    verdict,
    spenderReputation: rep ? {
      address: rep.addr,
      tier: rep.tier, // known | contract | eoa | unknown
      name: rep.name || null,
      basis: rep.tier === 'known' ? 'known-router/marketplace allowlist'
        : rep.tier === 'unknown' ? 'eth_getCode unavailable — treated as untrusted'
        : `eth_getCode → ${rep.delegated ? 'EIP-7702 delegated wallet' : rep.tier === 'eoa' ? 'externally-owned wallet (no contract code)' : 'unrecognized contract'}`,
      activity: rep.activity && Object.keys(rep.activity).length ? rep.activity : undefined, // codeSize / proxy / outbound-tx count (D11)
    } : undefined,
    targetContract: (to && /^0x[0-9a-fA-F]{40}$/.test(to)) ? { address: to, proxy: targetProxy || { isProxy: false } } : undefined,
    function: `${decoded.name}(${decoded.fragment.inputs.map((i) => i.type).join(',')})`,
    signatureUsed: usedSig,
    args,
    nativeValueWei: nativeValue.toString(),
    plainEnglish: describe(decoded.name, args, nativeValue),
    riskFlags: flags,
    simulation: simulation ? (simulation.error ? { available: false, note: 'Simulation unavailable: ' + simulation.error }
      : { available: true, wouldRevert: simulation.reverted, blockNumber: simulation.blockNumber, blockHash: simulation.blockHash || null, assetChanges: simulation.assetChanges, approvalsGranted: simulation.approvalChanges, gasCost: simulation.gas || null, simulatedVia: 'eth_simulateV1', evidenceBundle: simulation.evidenceBundle })
      : { available: false, note: 'Pass "to" and "from" (the unsigned tx) to simulate exact asset and approval changes.' },
    provenance,
    method: 'Decodes the 4-byte selector and arguments, and — given the full unsigned transaction — simulates it on the live chain state (eth_simulateV1) to report the exact asset transfers, approval changes, and gas cost the signer would incur. The spender is reputation-scored (known-router allowlist, EOA vs contract via eth_getCode incl. EIP-7702, code size and outbound-tx activity), and the target contract is checked for an EIP-1967 upgradeable proxy (its logic can change post-approval). A one-glance danger verdict and risk flags sit on top.',
    limitations: 'A selector can be ambiguous across signatures; the first that decodes cleanly is used. Simulation is a single tx against the latest block — it does not model multi-tx bundles, MEV/sandwich exposure, or custom state overrides (those need a bundle simulator, out of scope here). Deeper spender reputation (verified source, first-seen age in days, approval-graph) needs an indexer/explorer key that is not wired; the on-chain activity signals here are a reachable subset, disclosed as such.',
    elapsedMs: Date.now() - t0,
  };
}

function describe(name, args, nativeValue) {
  const a = (i) => args[i]?.value;
  if (name === 'approve') return BigInt(a(1) ?? 0) >= MAX_UINT ? `Approve ${a(0)} to spend an UNLIMITED amount of this token.` : `Approve ${a(0)} to spend ${a(1)} of this token.`;
  if (name === 'transfer') return `Transfer ${a(1)} tokens to ${a(0)}.`;
  if (name === 'setApprovalForAll') return `${a(1) ? 'GRANT' : 'Revoke'} operator ${a(0)} control over all your NFTs in this collection.`;
  if (name === 'transferOwnership') return `Transfer contract ownership to ${a(0)}.`;
  if (/^swap/i.test(name)) return `Execute a DEX swap (${name}).${nativeValue > 0n ? ` Sends ${nativeValue} wei of native token.` : ''}`;
  return `Call ${name}(${args.map((x) => x.name).join(', ')}).${nativeValue > 0n ? ` Sends ${nativeValue} wei of native token.` : ''}`;
}
