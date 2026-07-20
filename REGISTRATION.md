# Veritape — ASP registration copy (review-safe register)

Language kept factual/neutral: "authenticity", "organic volume", "verification",
"patterns consistent with coordinated trading". Avoid "fraud / scam / manipulation /
forensics" in the listing (reads legal). No links, no tech-stack names, no disclaimers,
no example prompts in service descriptions (OKX QA rules). Final check = `agent validate-listing`.

## Identity
- **Role**: ASP
- **Name**: `Veritape`  (pending Tristan confirm; alts: TapeProof / TruthTape / Verivol)
- **Avatar**: assets/veritape-logo.png (512×512 PNG, ~8.7 KB)
- **Description** (≤500 chars):
  > Veritape checks whether on-chain trading data can be trusted. It flags tokens whose volume shows patterns of manufactured trading, and wallets whose win rate and profit may be inflated rather than real skill. Every answer comes with a risk score, the specific wallets and transactions behind it, and a confidence level, so trading agents can vet a token or a track record before they act on it.

## Service 1
- **serviceName**: `Volume Authenticity Scan`
- **serviceType**: `A2MCP`
- **fee**: `0.1`
- **endpoint**: `https://veritape-production.up.railway.app/api/token-scan`
- **serviceDescription** (2 parts, each ≤200 chars):
  - ① Flags trading patterns consistent with manufactured volume — wash trading, round-trip churn, extreme turnover and velocity — and returns a manipulation-risk score with the specific wallets and transaction hashes as evidence.
  - ② You provide: 1. the chain (e.g. solana or ethereum) 2. the token contract address.

## Service 2
- **serviceName**: `Wallet Track Record Audit`
- **serviceType**: `A2MCP`
- **fee**: `0.1`
- **endpoint**: `https://veritape-production.up.railway.app/api/wallet-audit`
- **serviceDescription** (2 parts, each ≤200 chars):
  - ① Checks whether a wallet's win rate and profit reflect real skill or inflated activity — statistical strength, churn symmetry, profit concentration, and whether its best wins sit on fake-volume tokens.
  - ② You provide: 1. the chain (e.g. solana or ethereum) 2. the wallet address.

## Preconditions before `activate` (permanent endpoint)
1. `/diag` confirms Railway reaches web3.okx.com (else switch region — URL would change).
2. OKX dev-portal keys set in Railway env (facilitator verify/settle live).
3. Name confirmed.
4. Endpoint returns correct 402 + serves a real paid call (self-test).
