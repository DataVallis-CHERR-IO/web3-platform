import { NextResponse } from "next/server";
import { parseAppEnv } from "@cherrio/shared";
import { getClientIp, rpcRateLimiter } from "@/lib/security/rate-limit";
import { verifyOrigin } from "@/lib/security/origin";
import { checkRpcBody, forwardRpc, rpcUpstreams, RPC_MAX_BODY_BYTES } from "@/lib/chain/rpc-proxy";

// Same-origin read-only JSON-RPC proxy for the browser (see lib/chain/rpc-proxy.ts).
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Only our own pages may use it — not a free public RPC for other sites.
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const limit = rpcRateLimiter.check(getClientIp(request), { windowMs: 60_000, maxRequests: 300 });
  if (!limit.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(limit.reset) } });
  }
  const raw = await request.text();
  if (raw.length > RPC_MAX_BODY_BYTES) return NextResponse.json({ error: "body_too_large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const check = checkRpcBody(body);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const appEnv = parseAppEnv(process.env.APP_ENV ?? "local");
  const result = await forwardRpc(raw, rpcUpstreams(appEnv, process.env.RPC_URL || undefined));
  return new NextResponse(result.body, { status: result.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
