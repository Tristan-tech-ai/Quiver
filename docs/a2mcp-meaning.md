# What `A2MCP` means, and why the thirteen listings without an MCP tool are not a defect

**Written 29 July 2026.** Settled from OKX's own artifacts on this machine, not from the name.

All 22 Quiver services are listed on OKX with `serviceType: "A2MCP"`. The live `/mcp` endpoint exposes
**9** tools. So 13 registered services have no MCP tool behind them: options-desk, tape-pulse,
chart-press, protocol-pulse, poly-fill, poly-desk, updown-pulse, calldata-x, macro-sentry,
loop-digest, lp-desk, token-scan, wallet-audit.

The open question was whether `A2MCP` **promises** that a listed service is callable as an MCP tool.
If it does, 13 listings point at tools that do not exist. If it is a marketplace category and buyers
call the HTTP `endpoint`, there is nothing wrong.

## The answer

**`A2MCP` does not promise MCP-callability.** In every place OKX's own sources *define*, *validate* or
*act on* the enum, `A2MCP` means **API service**: fixed price, pay-per-call, settled over x402, and
the buyer calls the HTTPS `endpoint` directly. **No action is required, and nothing needs to change.**

## The sources

Every file below is OKX-authored (`license: Apache-2.0`, shipped in the `okx-ai` and
`okx-agent-payments-protocol` skill packs, v4.2.2) and was read on this machine.

**1. The definition.** `~/.claude/skills/okx-ai/references/identity-invariants.md`, line 10:

> **Service type:** A2MCP → **API service** · A2A → **agent to agent**. Gloss once per table:
> "API service = pay-per-call, fixed price; agent to agent = negotiated / off-chain pricing."
> Never raw A2MCP/A2A.

The gloss OKX mandates for its own UI is "pay-per-call, fixed price". Not "callable over MCP".

**2. What the enum actually selects.** `~/.claude/skills/okx-ai/references/task-cli-reference.md`,
line 396, describing `--service-type`:

> `A2A` or `A2MCP` (A2A -> escrow, A2MCP -> x402)

The enum picks the **settlement rail**. It says nothing about a calling protocol.

**3. The endpoint is the product, and it is mandatory for exactly this type.** Same
`identity-invariants.md`, the `--service` input contract (lines 70–72):

> `serviceType` | yes | raw enum `A2MCP` (API service) or `A2A` (agent to agent) — never the localized label
>
> `endpoint` | A2MCP only | `https://…`; **omit entirely for A2A**

`A2A` services are forbidden from carrying an endpoint; `A2MCP` services must carry one. A category
whose defining requirement is an HTTPS URL is a category about HTTP.

**4. The buyer's measured path has no MCP in it.** `task-user-actions-publish.md` routes an A2MCP
listing with a concrete endpoint out of the task skill entirely and into the x402 flow, which is
`onchainos agent x402-check --endpoint <endpoint>` — the CLI's own help calls it *"Validate an x402
endpoint and extract pricing info"* — followed by `agent task-402-pay`, whose help reads *"x402
Phase 2: x402_pay signing + direct/accept + endpoint replay"*. Probe the URL, read the HTTP 402
`accepts` array, sign, replay the HTTP request. There is no MCP handshake, no `tools/list`, no
`tools/call` anywhere in it.

**5. The decisive one: HTTP-vs-MCP is a different field.**
`~/.claude/skills/okx-agent-payments-protocol/SKILL.md`, line 179, in the table describing the x402
offer's own `outputSchema.input`:

> `input.type` | `"http"` → handle here. `"mcp"` → out of scope, skip param assembly.

Whether a service is invoked over HTTP or over MCP is carried by `input.type` **inside the payment
offer**, independently of `serviceType`. If `serviceType: A2MCP` already meant "MCP-callable", this
second discriminator would be redundant. It is not redundant.

## The one thing that points the other way, quoted rather than buried

The `onchainos` binary (v4.2.2) carries listing-validation strings. Extracted from
`~/.local/bin/onchainos.exe`, the issue/fix pairs read:

> `A2MCP service must have an endpoint.` / **`Provide the MCP endpoint URL.`**
> `A2A service must not have an endpoint.` / `Remove the endpoint field for A2A services.`
> `Endpoint must use HTTPS.` / `Change the URL scheme to https://.`
> `Endpoint must be a publicly reachable HTTPS URL (not localhost, 127.0.0.1, or a private network address).`

`Provide the MCP endpoint URL.` is **the only sentence in any source that calls the A2MCP endpoint an
MCP endpoint**, and the `agent update --help` example uses `https://api.example.com/mcp` as its
example path. Both are nominal. Two things defuse them: the string is a *fix hint* attached to an
issue whose enforced check is endpoint **presence**, not protocol; and every adjacent check is scheme
and public reachability. Nothing in the CLI validates that an endpoint speaks MCP, and nothing
requires it to expose a `tools/list` containing the service. `identity-register.md` §6 asks only that
the endpoint be *"`https://`, publicly reachable, and really deployed"*.

Worth saying plainly: the `okx-agent-payments-protocol` skill mentions `A2MCP` **exactly once**, in
its frontmatter trigger list, and its 328-line body never defines it. That trigger line groups it as
*"A2MCP / an A2MCP endpoint, or sending a request to / calling an Agent's endpoint with a concrete
endpoint URL"* — treating an A2MCP endpoint as a plain HTTP endpoint call.

## There was no better enum to have picked

The CLI enforces `servicetype must be exactly A2A or A2MCP.` — two values, confirmed in
`agent create --help`. There is no `HTTP`, `API` or `REST` option. `A2MCP` **is** the HTTP/API option;
the only alternative, `A2A`, forbids an endpoint outright and routes to escrow with negotiated
pricing. Registering 22 fixed-price HTTP services as `A2MCP` was the only valid choice available.

## What this means for the thirteen

Nothing is broken and nothing needs to change. Each of the 22 carries a working HTTPS `endpoint`,
which is what an `A2MCP` listing is defined by and what the x402 buyer flow actually calls. The MCP
surface at `/mcp` is an additional, independent convenience over 9 of the engines, not the thing the
registry is pointing at.

The whitepaper already words this correctly and does not overclaim: it describes the nine engines as
*"additionally exposed over a remote Model Context Protocol (MCP) endpoint"* — "additionally", and
nine, stated separately from the 22 registered services.

**So the trade never arises.** Had `A2MCP` demanded MCP-callability, the fix would have been to add
the 13 as MCP tools — code rather than registry, so no OKX re-review. But `/mcp` is unmetered
(`MCP_DAILY_CALLS = 300` per IP per day, Quiver's own counter in `src/app.js`), so that would have
given away 13 paid services for free. Since the premise is false, there is no decision to make here.

## What this does not settle

Every source is an OKX-authored artifact **on this machine** — the `okx-ai` and
`okx-agent-payments-protocol` skill packs and the `onchainos` v4.2.2 binary. OKX's public web
documentation was not consulted, so a public page wording it differently cannot be ruled out. The
local trees carry no registration payload documenting the original intent either way: `Quiver/`
contains zero `A2MCP` references outside `node_modules`.

The evidence is one-sided and consistent across four independent artifacts, but it is local evidence.
Nothing here was confirmed against OKX's live registry, and confirming it there would mean touching
the registry, which is forbidden while the 22 services are under review.

---

*A note for whoever searches next: ripgrep — and therefore the Grep tool — silently skips hidden
dot-directories, so it reports "no matches" for `A2MCP` while the string sits on line 3 of a file
under `~/.claude/skills/`. Skill-pack searches have to go through `grep -rn`.*
