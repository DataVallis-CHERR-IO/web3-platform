/**
 * Batch mode scenario (ADR-055, TASK-048): real Anvil (a block every second),
 * the unchanged deploy script, real Ponder started by the real runner
 * (scripts/batch.ts) every few seconds, real Postgres. Proves that each cycle
 * resumes the same schema (no re-index), that donations made between cycles
 * reach the chain.* views, and that the runner serves /health, /ready, /status.
 * Nothing is skipped: a missing anvil/forge binary or database fails the suite.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, http, keccak256, parseAbi, toHex,
  type Abi, type Address, type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CampaignAbi, CampaignFactoryAbi } from "@cherrio/contracts/abis";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexerDir = path.resolve(here, "..");
const contractsDir = path.resolve(here, "../../../packages/contracts");
const deploymentFile = path.join(contractsDir, "deployments/amoy-local-batch.json");
const CHAIN_ID = 80002;
const USDC: Address = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";
const MNEMONIC = "test test test test test test test test test test test junk";
const operator = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const ben = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const donor = mnemonicToAccount(MNEMONIC, { addressIndex: 4 });
const SCHEMA = `chain_b${Date.now().toString(36)}`;

let anvil: ChildProcess;
let runner: ChildProcess;
let proxy: Server;
/** eth_getLogs block ranges the runner and Ponder asked for (through the counting proxy). */
const getLogs: { from: number; to: number; at: number; limited?: boolean }[] = [];
let refusedRanges = 0;
/** eth_getLogs requests the proxy answered with HTTP 429. */
let rateLimited = 0;
/** Requests the blocked primary RPC answered (like Alchemy over its monthly limit). */
let blockedHits = 0;
let blocked: Server;
let runnerLog = "";
let admin: postgres.Sql;
let sql: postgres.Sql;
let testDb: string;
let runnerUrl: string;
let factory: Address;
let pub: ReturnType<typeof createPublicClient>;
let wallet: ReturnType<typeof createWalletClient>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function until(what: string, check: () => Promise<boolean>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runner && runner.exitCode !== null) throw new Error(`runner exited with ${runner.exitCode}\n${runnerLog.slice(-4000)}`);
    try {
      if (await check()) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${what}\n${runnerLog.slice(-4000)}`);
}

async function send(from: typeof operator, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await wallet.writeContract({ account: from, address, abi, functionName, args, chain: wallet.chain } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}

let n = 0;
/** Creates a campaign and donates 50 USDC to it; returns the campaign and the donation's block. */
async function donation() {
  n++;
  const offchainId = keccak256(toHex(`batch-${n}`));
  const now = (await pub.getBlock()).timestamp;
  await send(operator, factory, CampaignFactoryAbi as Abi, "createCampaign", [
    { offchainId, beneficiary: ben.address, target: 1_000_000_000n, deadline: now + 30n * 86_400n, beneficiaryType: 0 },
  ]);
  const campaign = (await pub.readContract({ address: factory, abi: CampaignFactoryAbi, functionName: "campaigns", args: [offchainId] })) as Address;
  await send(operator, USDC, parseAbi(["function mint(address,uint256)"]) as Abi, "mint", [donor.address, 50_000_000n]);
  await send(donor, USDC, parseAbi(["function approve(address,uint256) returns (bool)"]) as Abi, "approve", [campaign, 50_000_000n]);
  const receipt = await send(donor, campaign, CampaignAbi as Abi, "donate", [50_000_000n, 0, 0]);
  return { campaign: campaign.toLowerCase(), block: receipt.blockNumber };
}

const indexed = async (campaign: string) =>
  (await sql`select count(*)::int as n from chain.donation where campaign = ${campaign}`)[0]!.n as number;
const status = async () => (await (await fetch(`${runnerUrl}/status`)).json()) as { cherrio: { block: { number: number | null } }; mode: string };

beforeAll(async () => {
  const directUrl = process.env.DATABASE_URL_DIRECT;
  if (!directUrl) throw new Error("batch scenario test needs DATABASE_URL_DIRECT (direct Postgres)");
  admin = postgres(directUrl, { max: 1, onnotice: () => {} });
  testDb = `cherrio_indexer_batch_${Math.random().toString(36).slice(2, 10)}`;
  await admin`create database ${admin(testDb)}`;
  const url = new URL(directUrl);
  url.pathname = `/${testDb}`;
  sql = postgres(url.toString(), { max: 2, onnotice: () => {} });

  const rpcUrl = `http://127.0.0.1:${await freePort()}`;
  anvil = spawn("anvil", ["--chain-id", String(CHAIN_ID), "--port", new URL(rpcUrl).port, "--silent", "--block-time", "1"]);
  const chain = defineChain({ id: CHAIN_ID, name: "anvil-amoy", nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  pub = createPublicClient({ chain, transport: http(), pollingInterval: 100 });
  wallet = createWalletClient({ chain, transport: http() });
  const control = createTestClient({ chain, transport: http(), mode: "anvil" });
  await until("anvil", async () => (await pub.getChainId()) === CHAIN_ID, 15_000);

  execFileSync("forge", ["build"], { cwd: contractsDir, stdio: "pipe" });
  const mock = JSON.parse(readFileSync(path.join(contractsDir, "out/MockUSDC.sol/MockUSDC.json"), "utf8")) as { deployedBytecode: { object: Hex } };
  await control.setCode({ address: USDC, bytecode: mock.deployedBytecode.object });
  execFileSync("forge", ["script", "script/DeployAmoy.s.sol", "--rpc-url", rpcUrl, "--broadcast"], {
    cwd: contractsDir,
    stdio: "pipe",
    env: { ...process.env, DEPLOYER_PRIVATE_KEY: toHex(operator.getHdKey().privateKey!), SAFE_ADDRESS: operator.address, TREASURY_ADDRESS: operator.address, DEPLOY_NAME: "local-batch" },
  });
  // A history before the indexer starts: a cycle that re-reads it is visible in
  // the eth_getLogs ranges (the 2026-10-06 bug — every cycle re-scanned the factory
  // from its start block; a short chain could not show it).
  await control.mine({ blocks: 2_000 });

  factory = (JSON.parse(readFileSync(deploymentFile, "utf8")) as { contracts: { campaignFactory: { address: Address } } }).contracts.campaignFactory.address;

  // Counting proxy in front of Anvil for the indexer.
  const proxyPort = await freePort();
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      try {
        const parsed = JSON.parse(body) as { method: string; params?: { fromBlock?: string; toBlock?: string }[] } | { method: string; params?: { fromBlock?: string; toBlock?: string }[] }[];
        for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
          const q = r.params?.[0];
          if (r.method === "eth_getLogs" && q?.fromBlock && q.toBlock) {
            const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
            getLogs.push({ from, to, at: Date.now() });
            // Like Infura (the backup on dev), with the limits scaled down to this short chain:
            // ranges above the limit are refused with Infura's message, and every 4th
            // request is rate limited (HTTP 429, no JSON body). Ponder and the runner
            // must stay within INDEXER_GETLOGS_RANGE and wait out the 429s.
            if (!Array.isArray(parsed) && to - from >= 1_000) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ jsonrpc: "2.0", id: (parsed as { id?: unknown }).id ?? 1, error: { code: -32005, message: `range ${to - from} exceeds limit of 1000` } }));
              refusedRanges++;
              return;
            }
            if (getLogs.length % 4 === 0) {
              res.writeHead(429, { "content-type": "text/plain" });
              res.end("Too Many Requests");
              getLogs[getLogs.length - 1]!.limited = true;
              rateLimited++;
              return;
            }
          }
        }
      } catch {
        /* not JSON */
      }
      const up = httpRequest({ host: "127.0.0.1", port: Number(new URL(rpcUrl).port), method: "POST", path: "/", headers: { "content-type": "application/json" } }, (r) => {
        res.writeHead(r.statusCode ?? 500, { "content-type": "application/json" });
        r.pipe(res);
      });
      up.on("error", () => { res.writeHead(502); res.end(); });
      up.end(body);
    });
  });
  await new Promise<void>((r) => proxy.listen(proxyPort, "127.0.0.1", () => r()));

  // The primary RPC is blocked like Alchemy after its monthly limit (HTTP 429 +
  // JSON error); the proxy above is the fallback (David 2026-10-06: Alchemy
  // primary, Infura backup). Everything below must work through the fallback.
  const blockedPort = await freePort();
  blocked = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      blockedHits++;
      let id: unknown = 1;
      try {
        id = (JSON.parse(Buffer.concat(chunks).toString()) as { id?: unknown }).id ?? 1;
      } catch {
        /* batch or not JSON */
      }
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: 429, message: "Monthly capacity limit exceeded." } }));
    });
  });
  await new Promise<void>((r) => blocked.listen(blockedPort, "127.0.0.1", () => r()));

  const port = await freePort();
  runnerUrl = `http://127.0.0.1:${port}`;
  const { DATABASE_URL: _unused, ...rest } = process.env;
  runner = spawn(path.join(indexerDir, "node_modules/.bin/tsx"), ["scripts/batch.ts"], {
    cwd: indexerDir,
    env: {
      ...rest,
      APP_ENV: "local",
      // Ponder's RPC cache on, as on the servers (local otherwise disables it).
      INDEXER_CACHE: "1",
      INDEXER_DEPLOYMENT_FILE: deploymentFile,
      [`PONDER_RPC_URL_${CHAIN_ID}`]: `http://127.0.0.1:${blockedPort}`,
      [`PONDER_RPC_FALLBACK_URL_${CHAIN_ID}`]: `http://127.0.0.1:${proxyPort}`,
      DATABASE_URL_DIRECT: url.toString(),
      PONDER_TELEMETRY_DISABLED: "true",
      INDEXER_SCHEMA: SCHEMA,
      INDEXER_PORT: String(port),
      INDEXER_PONDER_PORT: String(await freePort()),
      INDEXER_BATCH_INTERVAL_SECONDS: "5",
      INDEXER_GETLOGS_RANGE: "1000",
    },
  });
  runner.stdout!.on("data", (d) => (runnerLog += d));
  runner.stderr!.on("data", (d) => (runnerLog += d));
}, 180_000);

afterAll(async () => {
  if (process.env.BATCH_TEST_LOG) (await import("node:fs")).writeFileSync(process.env.BATCH_TEST_LOG, runnerLog);
  runner?.kill("SIGTERM");
  if (runner && runner.exitCode === null) await new Promise((r) => runner.once("exit", r));
  anvil?.kill();
  proxy?.close();
  blocked?.close();
  await sql?.end();
  if (admin) {
    await admin`drop database if exists ${admin(testDb)} with (force)`;
    await admin.end();
  }
});

describe("indexer batch mode (Anvil + Ponder + runner)", () => {
  it("serves /health at once and /ready only after the first cycle", async () => {
    await until("runner /health", async () => (await fetch(`${runnerUrl}/health`)).status === 200, 30_000);
    const first = await donation();
    // The views show a cycle's rows a moment before the runner records its end block: wait for both.
    await until(
      "first cycle",
      async () =>
        (await fetch(`${runnerUrl}/ready`)).status === 200 &&
        (await indexed(first.campaign)) === 1 &&
        BigInt((await status()).cherrio.block.number ?? -1) >= first.block,
      180_000
    );
    expect((await status()).mode).toBe("batch");
  }, 240_000);

  it("later cycles resume the same schema and pick up new donations", async () => {
    const before = (await status()).cherrio.block.number!;
    const second = await donation();
    await until("second donation", async () => (await indexed(second.campaign)) === 1, 120_000);
    const third = await donation();
    await until("third donation", async () => (await indexed(third.campaign)) === 1, 120_000);
    expect((await status()).cherrio.block.number!).toBeGreaterThan(before);
    // Resumed, not re-indexed: Ponder's crash recovery on the same schema, and one schema only.
    expect(runnerLog).toContain("Detected crash recovery");
    expect(runnerLog).not.toContain("previously used by a different Ponder app");
    const schemas = await sql`select schema_name from information_schema.schemata where schema_name like 'chain_b%'`;
    expect(schemas.map((r) => r.schema_name)).toEqual([SCHEMA]);
    expect(runnerLog).toMatch(/\[indexer:batch\] .* indexed to block \d+/);
  }, 300_000);

  it("a cycle without new campaigns reads only the new blocks (no re-scan of the history)", async () => {
    const before = (await status()).cherrio.block.number!;
    await until("two more cycles", async () => (await status()).cherrio.block.number! > before + 5, 120_000);
    const mark = Date.now();
    const at = (await status()).cherrio.block.number!;
    await until("another cycle", async () => (await status()).cherrio.block.number! > at, 120_000);
    const idle = getLogs.filter((q) => q.at >= mark && !q.limited);
    expect(idle.length).toBeGreaterThan(0);
    // Every request of that cycle starts after the previous cycle's end (a few blocks
    // of overlap at most) — never back at the factory's start block thousands of blocks ago.
    expect(Math.min(...idle.map((q) => q.from)), JSON.stringify(idle)).toBeGreaterThan(at - 50);
    expect(idle.length).toBeLessThanOrEqual(8);
    // INDEXER_GETLOGS_RANGE kept every request within the backup's range limit
    // (dev 2026-10-06: Infura refused 50,000-block ranges and Ponder does not
    // recognise its message), and the 429s were waited out, not mistaken for a
    // refused range: no narrowing, no failed cycle.
    expect(refusedRanges, runnerLog.slice(-3000)).toBe(0);
    expect(rateLimited).toBeGreaterThan(0);
    expect(runnerLog).toContain("rate limited, retrying");
    expect(runnerLog).not.toContain("refused");
    expect(runnerLog).not.toContain("cycle failed");
    // Every request went to the blocked primary first, then to the fallback.
    expect(blockedHits).toBeGreaterThan(0);
  }, 300_000);
});
