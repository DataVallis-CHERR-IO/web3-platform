import http from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicClient, fallback, http as viemHttp, parseAbi } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { isEmptyResult, isRetryableRead, limiter, withReadRetry } from "../lib/rpc-read";

// Dev 2026-10-06: Alchemy over its monthly cap (HTTP 429 on everything), the
// Infura backup answering, and two reads in the first reconcile coming back
// as "0x". These tests use real viem clients against local JSON-RPC servers
// that answer exactly like that.

const POOL = "0xFa7Fd0253813E196d74575A8F93ABB91cd009517";
const CAMPAIGN = "0x2ea02dd9a1b2ebafd16150ce7cd3f3e01f42e033";
const abi = parseAbi(["function hasFundingPool(address) view returns (bool)"]);
const TRUE = `0x${"0".repeat(63)}1`;
const NO_DELAY = { delaysMs: [1, 1, 1, 1, 1], sleep: () => Promise.resolve() };

type Reply = { status: number; body: unknown };
const servers: http.Server[] = [];

/** A JSON-RPC server: `reply(n)` answers its n-th request (0-based); counts calls. */
async function server(reply: (n: number, id: unknown) => Reply) {
  let n = 0;
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const { id } = JSON.parse(raw) as { id: unknown };
      const { status, body } = reply(n++, id);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, calls: () => n };
}

const alchemyOverCap = () =>
  server((_, id) => ({ status: 429, body: { jsonrpc: "2.0", id, error: { code: 429, message: "Monthly capacity limit exceeded." } } }));
const result = (id: unknown, value: string): Reply => ({ status: 200, body: { jsonrpc: "2.0", id, result: value } });

function reader(urls: string[]) {
  const client = createPublicClient({ transport: fallback(urls.map((u) => viemHttp(u, { retryCount: 0 })), { rank: false }) });
  return () => client.readContract({ address: POOL, abi, functionName: "hasFundingPool", args: [CAMPAIGN], blockNumber: 49_460_153n });
}

afterAll(() => servers.forEach((s) => s.close()));

describe("reads through the backup RPC", () => {
  it("an empty answer from the backup is repeated and the real value used", async () => {
    const primary = await alchemyOverCap();
    const backup = await server((n, id) => result(id, n < 2 ? "0x" : TRUE));
    const retries: number[] = [];
    const value = await withReadRetry(reader([primary.url, backup.url]), { ...NO_DELAY, onRetry: (_, ms) => retries.push(ms) });
    expect(value).toBe(true);
    expect(retries).toHaveLength(2);
    expect(backup.calls()).toBe(3);
  });

  it("a rate limit from the backup (HTTP 429) is waited out", async () => {
    const primary = await alchemyOverCap();
    const backup = await server((n, id) =>
      n === 0 ? { status: 429, body: { jsonrpc: "2.0", id, error: { code: 429, message: "Too Many Requests" } } } : result(id, TRUE)
    );
    expect(await withReadRetry(reader([primary.url, backup.url]), NO_DELAY)).toBe(true);
    expect(backup.calls()).toBe(2);
  });

  it("an empty answer that persists still fails, after the last pause", async () => {
    const primary = await alchemyOverCap();
    const backup = await server((_, id) => result(id, "0x"));
    await expect(withReadRetry(reader([primary.url, backup.url]), { delaysMs: [1, 1], sleep: () => Promise.resolve() })).rejects.toThrow(
      /returned no data/
    );
    expect(backup.calls()).toBe(3);
  });

  it("a revert is not repeated", async () => {
    const backup = await server((_, id) => ({ status: 200, body: { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: "0x" } } }));
    await expect(withReadRetry(reader([backup.url]), NO_DELAY)).rejects.toThrow();
    expect(backup.calls()).toBe(1);
  });
});

describe("isRetryableRead", () => {
  it("knows empty results and rate limits, nothing else", () => {
    expect(isEmptyResult({ name: "ContractFunctionExecutionError", cause: { name: "ContractFunctionZeroDataError" } })).toBe(true);
    expect(isRetryableRead({ name: "HttpRequestError", status: 429 })).toBe(true);
    expect(isRetryableRead({ name: "RpcRequestError", code: -32005, message: "request rate exceeded" })).toBe(true);
    expect(isRetryableRead({ name: "RpcRequestError", code: -32005, message: "range 49999 exceeds limit of 10000" })).toBe(false);
    expect(isRetryableRead({ name: "ContractFunctionRevertedError", message: "execution reverted" })).toBe(false);
    expect(isRetryableRead(new Error("connection refused"))).toBe(false);
  });
});

describe("limiter", () => {
  it("never has more than max calls in flight", async () => {
    const limit = limiter(3);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    };
    await Promise.all(Array.from({ length: 40 }, () => limit(task)));
    expect(peak).toBe(3);
  });

  it("releases the slot when a call fails", async () => {
    const limit = limiter(1);
    await expect(limit(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await limit(() => Promise.resolve(5))).toBe(5);
  });
});
