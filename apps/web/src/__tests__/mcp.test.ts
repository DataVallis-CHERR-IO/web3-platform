import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as schema from "@cherrio/db";
import { TRUST_SCORE_VERSION } from "@cherrio/shared/trust";
import { getDb } from "@/lib/db";
import { GET, OPTIONS, POST } from "@/app/mcp/route";

// TASK-020: the read-only MCP server, driven by the official MCP client SDK
// over HTTP (a small Node server hands requests to the route handlers).

if (!process.env.DATABASE_URL) throw new Error("mcp tests need DATABASE_URL");
const db = getDb();
const { organizations, trustScores } = schema;
const RUN = `Mcp${Date.now().toString(36)}`;
const ids: string[] = [];
let server: Server;
let url = "";
let client: Client;

beforeAll(async () => {
  const [o] = await db
    .insert(organizations)
    .values({ source: "REGISTERED", name: `${RUN} Paws`, country: "SI", registry: "NONE", causes: ["animals"], kybStatus: "APPROVED" })
    .returning({ id: organizations.id });
  ids.push(o!.id);
  await db.insert(trustScores).values({ orgId: o!.id, version: TRUST_SCORE_VERSION, score: "61.00", components: { kind: "registered" }, listed: true, registered: true, country: "SI", causes: ["animals"], raised: "0" });

  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: { ...(req.headers as Record<string, string>), "x-forwarded-for": "10.77.0.1" },
      body: req.method === "POST" ? body : undefined,
    });
    const handler = req.method === "POST" ? POST : req.method === "OPTIONS" ? OPTIONS : GET;
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  client = new Client({ name: "cherrio-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
});

afterAll(async () => {
  await client?.close();
  server?.close();
  await db.delete(trustScores).where(inArray(trustScores.orgId, ids));
  await db.delete(organizations).where(inArray(organizations.id, ids));
});

describe("MCP server", () => {
  it("initialises with the official client and lists five read-only tools", async () => {
    expect(client.getServerVersion()).toMatchObject({ name: "cherrio" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search_charities", "get_charity", "list_campaigns", "get_campaign", "trust_score_methodology"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("searches charities and opens one", async () => {
    const found = await client.callTool({ name: "search_charities", arguments: { query: RUN, on_cherrio: true, limit: 5 } });
    const data = found.structuredContent as { charities: { id: string; name: string; trustScore: string }[]; next: string | null };
    expect(data.charities).toEqual([expect.objectContaining({ id: ids[0], name: `${RUN} Paws`, trustScore: "61.00" })]);
    const one = await client.callTool({ name: "get_charity", arguments: { id: ids[0] } });
    expect(one.structuredContent).toMatchObject({ id: ids[0], onCherrio: true, trustScore: { score: "61.00", version: TRUST_SCORE_VERSION } });
    const missing = await client.callTool({ name: "get_charity", arguments: { id: "00000000-0000-4000-8000-000000000000" } });
    expect(missing.isError).toBe(true);
  });

  it("lists campaigns, explains the score, refuses unknown tools", async () => {
    const list = await client.callTool({ name: "list_campaigns", arguments: { sort: "newest" } });
    expect(list.structuredContent).toMatchObject({ page: 1 });
    const method = await client.callTool({ name: "trust_score_methodology", arguments: {} });
    expect(JSON.stringify(method.content)).toContain("Trust Score v1");
    await expect(client.callTool({ name: "delete_everything", arguments: {} })).rejects.toThrow(/Unknown tool/);
  });

  it("answers plain HTTP correctly: notifications 202, GET 405, bad JSON 400, bad version 400", async () => {
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });
    expect((await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);
    expect((await fetch(url)).status).toBe(405);
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), { "mcp-protocol-version": "1999-01-01" })).status).toBe(400);
    const batch = await (await post(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]))).json();
    expect(batch.error.code).toBe(-32600);
  });
});
