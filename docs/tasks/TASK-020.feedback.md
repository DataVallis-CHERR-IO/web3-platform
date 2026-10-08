# TASK-020 feedback — read-only MCP server
Status: DONE (Built; PR pending) — David 2026-10-08: "nadaljuj z … strežnik MCP za AI orodja, ki bi podatke samo bral".

## What I implemented
- `POST /mcp` (`app/mcp/route.ts`, `lib/mcp/server.ts`): MCP over **Streamable HTTP without sessions** — one JSON-RPC message per POST, one JSON answer; notifications → 202; GET/DELETE → 405 (no server-initiated stream); `MCP-Protocol-Version` checked (2025-06-18, 2025-03-26, 2024-11-05); single messages only (batches refused, as in 2025-06-18); 64 KB body limit; CORS `*`; the API's 120 requests/min per IP.
- Tools (all `readOnlyHint`): `search_charities` (Market Cap filters, cursor), `get_charity`, `list_campaigns`, `get_campaign`, `trust_score_methodology`. Results as `structuredContent` + JSON text; unknown ids → `isError`. Same serializers as the REST API (TASK-018b), so the same fields, no personal data.
- Documented on `/en/docs/api` ("MCP server for AI assistants") and in `/llms.txt`.

## Deviations
- **Served by the web app, not a separate `apps/mcp` service** (Architecture §5 plans an `mcp` Kamal service on prod). Reason: read-only, the same queries and serializers as the public API; a separate service would need its own image, Kamal config, secrets and deploy job for no gain now ("ne več dela kot koristi"). `apps/mcp` stays an empty scaffold; move it out if MCP traffic ever needs its own scaling.
- No authentication (public data, like the REST API).

## New dependencies
- `@modelcontextprotocol/sdk@1.30.0` (**dev only**, web) — the tests drive the server with the official client to prove compatibility; the server itself has no MCP dependency.

## Test results
`src/__tests__/mcp.test.ts` (4: official client initialises and lists five read-only tools; search + get charity, unknown id is an error; campaigns, methodology, unknown tool refused; raw HTTP: 202, 405, parse error 400, bad protocol version 400, batch refused): `Tests 4 passed (4)`. Deliberate break (server answers protocol version 1999-01-01):
```
Error: Server's protocol version is not supported: 1999-01-01
      Tests  4 skipped (4)
```
restored → passing.

## How to try
In an MCP client (e.g. Claude → Settings → Connectors → add custom connector) add `https://dev.cherr.io/mcp`, then ask e.g. "Which animal charities in the UK have the highest Trust Score?".
