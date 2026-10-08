# apps/mcp — not used

The read-only MCP server is served by the web app at `POST /mcp`
(`apps/web/src/app/mcp/route.ts`, `apps/web/src/lib/mcp/server.ts`, TASK-020):
it reads the same data with the same serializers as the public API. This
scaffold stays for a separate service if MCP traffic ever needs its own scaling.
