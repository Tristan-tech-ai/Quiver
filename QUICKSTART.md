# Quiver — Quickstart (use the risk brain in <5 minutes)

Quiver is a **verifiable risk brain for AI agents**. Most agent tools hand you a number you have to *trust*;
Quiver hands you one you can *re-derive*. This is how to call it — no install, no key, free tier.

- **Remote MCP:** `https://quiver-production-c3a8.up.railway.app/mcp` (Streamable HTTP, 9 tools)
- **Paid ASP (x402):** 22 services, dual rail — X Layer USD₮0 + Base USDC
- **On-chain:** ERC-8004 agent `#5152` · batch proofs anchored on Base EAS

---

## 1. Try it in 30 seconds (curl, no install)

List the tools:
```bash
curl -s https://quiver-production-c3a8.up.railway.app/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Call one — a perp liquidation check (free tier, deterministic on the inputs you pass):
```bash
curl -s https://quiver-production-c3a8.up.railway.app/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"perp_gate",
        "arguments":{"side":"long","entryPrice":64000,"size":1,"margin":6400,"maxLeverage":40}}}'
```

You get back the money-math **plus a proof envelope**:
```jsonc
{
  "liquidationPrice": 58329.11,
  "moveToLiquidationPct": -8.86,
  "effectiveLeverage": 10,
  "marginTier": { /* ... */ },
  "funding": { /* ... */ },
  "checks": [ /* liquidation-invariant self-check */ ],
  "proof": {
    "engine": "perp-gate",
    "codeHash": "q1-3e36dcbe3a0a7843",     // == /build codeHash; rebuild from source to reproduce
    "inputs":  { /* echoed */ },
    "selfChecks": [ /* each re-checkable */ ],
    "allSelfChecksPass": true,
    "contentHash": "…",                     // hash of the exact result
    "reproduce": "re-run the open engine on `inputs` → identical contentHash",
    "attestation": { /* EIP-712, EAS-ready */ }
  }
}
```

## 2. The point: re-derive, don't trust

The `proof` is the product. To verify an answer you didn't have to trust:

1. `GET /build` → the `codeHash` of the open-source engines (equals `proof.codeHash` on every answer).
2. Rebuild from [the repo](https://github.com/Tristan-tech-ai/Quiver) → identical `codeHash`.
3. Re-run the engine on `proof.inputs` (same Node) → **byte-identical `contentHash`**.

Correctness you recompute — not a signature you trust. Batches of these proofs anchor to Base EAS, so many
computations are attested by one on-chain root.

## 3. Add it to your agent (by URL)

Quiver is a standard remote MCP server, so any MCP-capable framework adds it by URL — no SDK:

- **Claude / Cursor / any MCP client** — add the server URL `…/mcp`.
- **LangChain, CrewAI, OpenAI Agents SDK, Vercel AI SDK, ElizaOS, Virtuals** — copy-paste snippets in [`INTEGRATIONS.md`](INTEGRATIONS.md).

## 4. When you need the paid tier (x402)

Free MCP covers the deterministic T0 risk math. Live-market data and on-chain **attestation** run on the x402
paid routes (`POST /api/<service>`). An unpaid request returns `402` with a populated `accepts[]` on **both**
rails (X Layer USD₮0 + Base USDC); sign an EIP-3009 authorization and resend. See the
[technical documentation](https://quiver-production-c3a8.up.railway.app/paper) for the full flow.

## 5. The 9 free MCP tools

`perp_gate` · `portfolio_gate` · `size_gate` · `exec_verify` · `options_risk` · `lp_risk` · `treasury_risk` · `risk_attest` · `event_vol`

Full service catalog (22, incl. options/microstructure/prediction-market intelligence) + prices: [README](README.md).
