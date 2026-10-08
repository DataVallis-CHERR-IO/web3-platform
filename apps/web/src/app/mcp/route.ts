/**
 * POST /mcp — read-only MCP server (TASK-020), Streamable HTTP without sessions:
 * one JSON-RPC message per request, one JSON answer (202 for notifications).
 * Add it to an MCP client as a remote server: https://app.cherr.io/mcp
 */
import { apiLimit, siteOrigin } from "@/lib/api/v1";
import { getDb } from "@/lib/db";
import { handleMcpMessage, PROTOCOL_VERSIONS } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id",
};
const MAX_BODY = 64 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });

export async function POST(request: Request) {
  const limited = apiLimit(request);
  if (limited) return limited;
  const version = request.headers.get("mcp-protocol-version");
  if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${version}` } }, 400);
  }
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413);
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const answer = await handleMcpMessage(getDb(), siteOrigin(), message);
  if (!answer) return new Response(null, { status: 202, headers: CORS });
  return json(answer);
}

/** No server-initiated stream and no sessions: only POST. */
function notAllowed() {
  return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS", ...CORS } });
}
export const GET = notAllowed;
export const DELETE = notAllowed;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
}
