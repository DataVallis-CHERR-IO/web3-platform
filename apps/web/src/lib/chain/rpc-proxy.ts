// Same-origin JSON-RPC proxy for the browser (`POST /api/rpc`).
//
// Why: viem / Privy's smart-wallet client read the chain through the chain's
// `rpcUrls`. Public endpoints such as rpc-amoy.polygon.technology fail from the
// browser (CORS / network errors), which stopped Privy from creating the smart
// account (TASK-011c follow-up). The browser now talks only to our origin; the
// server forwards to an upstream (no CORS server-side) and falls back to the
// next upstream on a network error, a timeout or a 5xx.
//
// Rules: read-only methods only (no eth_sendRawTransaction — wallets send through
// their own provider or the bundler), at most 20 calls per batch, body ≤ 64 KB.

import type { AppEnv } from "@cherrio/shared";

export const RPC_ALLOWED_METHODS = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
]);

export const RPC_MAX_BATCH = 20;
export const RPC_MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Public upstreams per environment, tried in order after `RPC_URL` (if set). */
const PUBLIC_UPSTREAMS: Record<AppEnv, string[]> = {
  local: ["http://127.0.0.1:8545"],
  dev: ["https://polygon-amoy-bor-rpc.publicnode.com", "https://rpc-amoy.polygon.technology"],
  uat: ["https://polygon-amoy-bor-rpc.publicnode.com", "https://rpc-amoy.polygon.technology"],
  prod: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
};

/** `RPC_URL` (optional server env, e.g. a private Alchemy URL) first, then the public ones. */
export function rpcUpstreams(appEnv: AppEnv, rpcUrl: string | undefined): string[] {
  const list = rpcUrl ? [rpcUrl, ...PUBLIC_UPSTREAMS[appEnv]] : [...PUBLIC_UPSTREAMS[appEnv]];
  return [...new Set(list)];
}

interface RpcCall {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export type RpcCheck = { ok: true } | { ok: false; status: 400 | 413; error: string };

/** Validates a parsed JSON-RPC body (single call or batch) before it is forwarded. */
export function checkRpcBody(body: unknown): RpcCheck {
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0) return { ok: false, status: 400, error: "empty_batch" };
  if (calls.length > RPC_MAX_BATCH) return { ok: false, status: 413, error: "batch_too_large" };
  for (const call of calls as RpcCall[]) {
    if (!call || typeof call !== "object" || typeof call.method !== "string") return { ok: false, status: 400, error: "invalid_request" };
    if (!RPC_ALLOWED_METHODS.has(call.method)) return { ok: false, status: 400, error: "method_not_allowed" };
  }
  return { ok: true };
}

/**
 * Forwards the raw body to the first upstream that answers (HTTP < 500).
 * Returns the upstream status and text; 502 when every upstream failed.
 * Upstream URLs are never put into the response (a private one may carry a key).
 */
export async function forwardRpc(
  rawBody: string,
  upstreams: string[],
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; body: string }> {
  for (const url of upstreams) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawBody,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (res.status >= 500) continue;
      return { status: res.status, body: await res.text() };
    } catch {
      // network error or timeout → next upstream
    }
  }
  return { status: 502, body: JSON.stringify({ error: "rpc_unavailable" }) };
}
