# Quiver — Framework Integrations

Quiver's risk brain is a standard **remote MCP server** (Streamable HTTP, no auth, free tier):

```
https://quiver-production-c3a8.up.railway.app/mcp
```

Add it by URL to any MCP-capable framework — no SDK, no key. Every tool result carries a re-runnable,
self-checked proof (see [QUICKSTART.md](QUICKSTART.md)). Snippets below are verified against the
frameworks' current releases (July 2026).

> **Gotcha #1 — the transport string is spelled differently per framework:**
> `streamable_http` (LangChain, underscore) · `streamable-http` (ElizaOS / CrewAI, hyphen) · `http` (Vercel AI SDK). Copy each snippet exactly.

| Framework | Package (current) | Transport key |
|---|---|---|
| Claude Code / Desktop, Cursor | built-in MCP client | `http` / `url` |
| ElizaOS | `@elizaos/plugin-mcp` 1.8.x | `"type": "streamable-http"` |
| LangChain / LangGraph | `langchain-mcp-adapters` ≥0.3.0 | `"transport": "streamable_http"` |
| CrewAI | `crewai-tools[mcp]` 1.x | `"transport": "streamable-http"` |
| OpenAI Agents SDK | `openai-agents` (Py) / `@openai/agents` (JS) | `MCPServerStreamableHttp` |
| Vercel AI SDK | `ai` v7 + `@ai-sdk/mcp` | `transport: { type: 'http' }` |
| Virtuals G.A.M.E | `game-sdk` (no native MCP) | custom `Function` bridge |

---

## Claude Code · Claude Desktop · Cursor

```bash
# Claude Code (CLI)
claude mcp add --transport http quiver https://quiver-production-c3a8.up.railway.app/mcp
```

```jsonc
// Cursor — .cursor/mcp.json (project) or ~/.cursor/mcp.json (global)
{ "mcpServers": { "quiver": { "url": "https://quiver-production-c3a8.up.railway.app/mcp" } } }
```

In Claude Desktop: Settings → Connectors → Add custom connector → paste the URL.

## ElizaOS

Use the official generic MCP plugin (`@elizaos/plugin-mcp`; the older `@fleek-platform/eliza-plugin-mcp` is deprecated):

```bash
elizaos plugins add @elizaos/plugin-mcp    # or: bun add @elizaos/plugin-mcp
```

```jsonc
// character config
{
  "name": "YourAgent",
  "plugins": ["@elizaos/plugin-mcp"],
  "settings": {
    "mcp": {
      "servers": {
        "quiver": {
          "type": "streamable-http",   // note: `type`, not `transport`
          "url": "https://quiver-production-c3a8.up.railway.app/mcp"
        }
      }
    }
  }
}
```

The plugin exposes the 9 Quiver tools via its `CALL_MCP_TOOL` action automatically — no custom code needed.

## LangChain / LangGraph (Python)

```bash
pip install -U langchain-mcp-adapters langgraph "langchain[anthropic]"
```

```python
import asyncio
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent

client = MultiServerMCPClient({
    "quiver": {
        "transport": "streamable_http",   # underscore
        "url": "https://quiver-production-c3a8.up.railway.app/mcp",
    }
})

async def main():
    tools = await client.get_tools()      # async; returns all 9 tools
    agent = create_react_agent("anthropic:claude-sonnet-4-5", tools)
    out = await agent.ainvoke({"messages": [{"role": "user",
        "content": "Long 1 BTC from 64000, 6400 margin, 40x cap — where do I liquidate?"}]})
    print(out["messages"][-1].content)

asyncio.run(main())
```

> Use direct instantiation + `await client.get_tools()` — the old `async with MultiServerMCPClient(...)` context-manager form is pre-0.1 legacy.

## CrewAI (Python)

```bash
pip install 'crewai-tools[mcp]'
```

```python
from crewai import Agent, Task, Crew, Process
from crewai_tools import MCPServerAdapter

server_params = {
    "url": "https://quiver-production-c3a8.up.railway.app/mcp",
    "transport": "streamable-http",   # hyphen
}

with MCPServerAdapter(server_params) as tools:
    analyst = Agent(
        role="Risk Analyst",
        goal="Answer risk questions with Quiver's verifiable tools.",
        backstory="Uses a deterministic, proof-carrying risk brain.",
        tools=tools,
    )
    task = Task(description="Check the liquidation risk of a 10x BTC long.",
                expected_output="Liquidation price + distance, with the proof summary.",
                agent=analyst)
    print(Crew(agents=[analyst], tasks=[task], process=Process.sequential).kickoff())
```

## OpenAI Agents SDK

**Python** (`pip install openai-agents`) — note the URL nests inside `params`, and bump the 5s default timeout:

```python
import asyncio
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

async def main():
    async with MCPServerStreamableHttp(
        name="Quiver Risk Brain",
        params={"url": "https://quiver-production-c3a8.up.railway.app/mcp"},
        cache_tools_list=True,
        client_session_timeout_seconds=30,
    ) as server:
        agent = Agent(name="Assistant",
                      instructions="Use the Quiver tools for any risk math.",
                      mcp_servers=[server])
        result = await Runner.run(agent, "Size a bet: 55% win prob, 1.2 win/loss, 10k bankroll.")
        print(result.final_output)

asyncio.run(main())
```

**JavaScript** (`npm install @openai/agents`) — URL is top-level here, and you manage the lifecycle:

```ts
import { Agent, run, MCPServerStreamableHttp } from '@openai/agents';

const server = new MCPServerStreamableHttp({
  url: 'https://quiver-production-c3a8.up.railway.app/mcp',
  name: 'Quiver Risk Brain',
  cacheToolsList: true,
});

await server.connect();
try {
  const agent = new Agent({ name: 'Assistant',
    instructions: 'Use the Quiver tools for any risk math.', mcpServers: [server] });
  const result = await run(agent, 'Where does a 10x BTC long from 64000 liquidate?');
  console.log(result.finalOutput);
} finally {
  await server.close();
}
```

## Vercel AI SDK (v7)

MCP lives in the dedicated `@ai-sdk/mcp` package now (stable `createMCPClient`; the old
`experimental_createMCPClient` in `ai` is the v4/v5 legacy path).

```bash
npm install ai @ai-sdk/mcp @ai-sdk/anthropic zod
```

```ts
import { generateText, isStepCount } from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';
import { anthropic } from '@ai-sdk/anthropic';

const mcpClient = await createMCPClient({
  transport: { type: 'http', url: 'https://quiver-production-c3a8.up.railway.app/mcp' },
});

try {
  const tools = await mcpClient.tools();
  const result = await generateText({
    model: anthropic('claude-sonnet-4-5'),
    tools,
    stopWhen: isStepCount(5),   // let it call a tool, read the proof, then answer
    prompt: 'Stress my portfolio: 2 BTC long Hyperliquid, 1 BTC short dYdX, 30% correlated crash.',
  });
  console.log(result.text);
} finally {
  await mcpClient.close();
}
```

> v7 is ESM-only (Node 22+). Without `stopWhen`, the model stops after one step and never acts on the tool result.

## Virtuals Protocol — G.A.M.E

G.A.M.E has **no native MCP client** — wrap Quiver as a custom `Function` (its `executable` is plain Python):

```bash
pip install game-sdk mcp
```

```python
import asyncio, json
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from game_sdk.game.custom_types import Function, Argument, FunctionResultStatus

MCP_URL = "https://quiver-production-c3a8.up.railway.app/mcp"

def call_quiver(tool_name: str, arguments_json: str = "{}", **kwargs):
    async def _run():
        async with streamablehttp_client(MCP_URL) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await session.call_tool(tool_name, json.loads(arguments_json))
    res = asyncio.run(_run())
    text = res.content[0].text if res.content else ""
    return FunctionResultStatus.DONE, text, {}   # executable must return this 3-tuple

quiver_tool = Function(
    fn_name="call_quiver",
    fn_description="Call a Quiver risk tool (perp_gate, portfolio_gate, size_gate, "
                   "exec_verify, options_risk, lp_risk, treasury_risk, risk_attest, event_vol)",
    args=[Argument(name="tool_name", description="Quiver MCP tool name"),
          Argument(name="arguments_json", description="JSON string of tool arguments")],
    executable=call_quiver,
)
# add `quiver_tool` to a WorkerConfig(action_space=[...]) on your G.A.M.E agent
```

## Any language — raw JSON-RPC over HTTP

No MCP client at all? It's one POST:

```bash
curl -s https://quiver-production-c3a8.up.railway.app/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"size_gate",
        "arguments":{"winProb":0.55,"winLossRatio":1.2,"bankroll":10000}}}'
```

## The paid tier (x402)

Live-market data + on-chain attestation run on the paid `POST /api/<service>` routes — 22 services, paid
in-band over x402 (X Layer USD₮0 **and** Base USDC). An unpaid request returns the standard `402` challenge
with both rails in `accepts[]`. Details: [technical documentation](https://quiver-production-c3a8.up.railway.app/paper).
