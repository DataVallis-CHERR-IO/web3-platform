import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/rpc/route";
import { rpcRateLimiter } from "@/lib/security/rate-limit";
import { checkRpcBody, forwardRpc, rpcUpstreams, RPC_MAX_BATCH } from "@/lib/chain/rpc-proxy";

// Same-origin JSON-RPC proxy (TASK-011c follow-up): read-only methods, fallback
// between upstreams, no upstream URL in responses, own origin only, rate limit.

const call = (method: string, id = 1) => ({ jsonrpc: "2.0", id, method, params: [] });
const OK = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x13882" });

function rpcRequest(body: unknown, origin = "http://localhost:3000", ip = "203.0.113.7") {
  return new Request("http://localhost:3000/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("checkRpcBody", () => {
  it("allows read-only calls and batches", () => {
    expect(checkRpcBody(call("eth_call"))).toEqual({ ok: true });
    expect(checkRpcBody([call("eth_chainId"), call("eth_getCode", 2)])).toEqual({ ok: true });
  });

  it.each([
    ["eth_sendRawTransaction", { ok: false, status: 400, error: "method_not_allowed" }],
    ["eth_sendTransaction", { ok: false, status: 400, error: "method_not_allowed" }],
    ["eth_getLogs", { ok: false, status: 400, error: "method_not_allowed" }],
  ])("refuses %s", (method, expected) => {
    expect(checkRpcBody(call(method))).toEqual(expected);
  });

  it("refuses an oversized or empty batch and malformed calls", () => {
    expect(checkRpcBody(Array.from({ length: RPC_MAX_BATCH + 1 }, (_, i) => call("eth_chainId", i)))).toMatchObject({ status: 413 });
    expect(checkRpcBody([])).toMatchObject({ status: 400 });
    expect(checkRpcBody({ id: 1 })).toMatchObject({ error: "invalid_request" });
  });
});

describe("rpcUpstreams", () => {
  it("puts RPC_URL first and never uses the old browser-blocked endpoint first on Amoy", () => {
    expect(rpcUpstreams("dev", "https://private.example/rpc")[0]).toBe("https://private.example/rpc");
    expect(rpcUpstreams("dev", undefined)[0]).not.toBe("https://rpc-amoy.polygon.technology");
    expect(rpcUpstreams("prod", undefined).length).toBeGreaterThan(1);
  });
});

describe("forwardRpc", () => {
  it("falls back on a network error and on a 5xx", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("bad gateway", { status: 503 }))
      .mockResolvedValueOnce(new Response(OK, { status: 200 }));
    const result = await forwardRpc(JSON.stringify(call("eth_chainId")), ["https://a", "https://b", "https://c"], fetchImpl);
    expect(result).toEqual({ status: 200, body: OK });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(["https://a", "https://b", "https://c"]);
  });

  it("answers 502 without naming any upstream when all fail", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const result = await forwardRpc("{}", ["https://secret-key.example/v2/abc"], fetchImpl);
    expect(result.status).toBe(502);
    expect(result.body).not.toContain("secret-key");
  });
});

describe("POST /api/rpc", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("APP_ENV", "local");
    vi.stubEnv("RPC_URL", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards an allowed call from our own origin", async () => {
    fetchMock.mockResolvedValueOnce(new Response(OK, { status: 200 }));
    const res = await POST(rpcRequest(call("eth_chainId")));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(OK);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses another site's origin and a write method — nothing is forwarded", async () => {
    expect((await POST(rpcRequest(call("eth_chainId"), "https://evil.example"))).status).toBe(403);
    const write = await POST(rpcRequest(call("eth_sendRawTransaction")));
    expect(write.status).toBe(400);
    expect(await write.json()).toEqual({ error: "method_not_allowed" });
    expect((await POST(rpcRequest("{not json"))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate-limits one IP at 300 calls a minute", async () => {
    fetchMock.mockImplementation(async () => new Response(OK, { status: 200 }));
    const ip = `198.51.100.${Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < 300; i++) rpcRateLimiter.check(ip, { windowMs: 60_000, maxRequests: 300 });
    const res = await POST(rpcRequest(call("eth_chainId"), "http://localhost:3000", ip));
    expect(res.status).toBe(429);
  });
});
