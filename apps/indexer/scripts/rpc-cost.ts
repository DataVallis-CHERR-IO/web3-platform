/**
 * RPC cost measurement (TASK-048, ADR-055) — a local tool, not run in CI.
 * How many RPC calls does the indexer make (a) following every block (realtime)
 * and (b) in batch mode — the real runner scripts/batch.ts, every SPIKE_INTERVAL s?
 * SPIKE_MINE blocks (default 3,000) are mined first so the chain has a history:
 * a cycle that re-reads it shows up as a growing list of eth_getLogs ranges
 * (the 2026-10-06 bug — a 300-block chain could not show it).
 * Anvil (chain 80002, a block every SPIKE_BLOCK_TIME s) behind a counting proxy,
 * the real deploy script, real Postgres; prints calls per method and an
 * Alchemy-CU estimate per phase. Needs anvil/forge on PATH (solc at
 * /opt/foundry/solc-0.8.24, offline) and DATABASE_URL_DIRECT; uses its own
 * database `cherrio_spike`.
 *   DATABASE_URL_DIRECT=… SPIKE_REALTIME_SECONDS=60 SPIKE_CYCLES=5 [SPIKE_IDLE=1] tsx scripts/rpc-cost.ts
 * SPIKE_PRIMARY_DOWN=1: the primary answers 429 "Monthly capacity limit
 * exceeded" and the counted proxy is the backup (dev on 2026-10-06);
 * SPIKE_CAMPAIGNS=n creates n campaigns with a donation before the history.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, http as viemHttp, keccak256, parseAbi, toHex,
  type Abi, type Address, type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { CampaignAbi, CampaignFactoryAbi } from "@cherrio/contracts/abis";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexerDir = path.resolve(here, "..");
const contractsDir = path.resolve(here, "../../../packages/contracts");
const deploymentFile = path.join(contractsDir, "deployments/amoy-local-test.json");
const CHAIN_ID = 80002;
const USDC: Address = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";
const BLOCK_TIME = Number(process.env.SPIKE_BLOCK_TIME ?? 1);
const REALTIME_SECONDS = Number(process.env.SPIKE_REALTIME_SECONDS ?? 120);
const MNEMONIC = "test test test test test test test test test test test junk";
const operator = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const donor = mnemonicToAccount(MNEMONIC, { addressIndex: 4 });
const ben = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });

const ANVIL_PORT = 18545;
const PROXY_PORT = 18546;
const PONDER_PORT = 42070;
const directUrl = process.env.DATABASE_URL_DIRECT!;

// ── counting proxy ─────────────────────────────────────────────────────────
let counts: Record<string, number> = {};
let ranges: string[] = [];
const proxy = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    try {
      const parsed = JSON.parse(body) as { method: string } | { method: string }[];
      for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
        counts[r.method] = (counts[r.method] ?? 0) + 1;
        if (r.method === "eth_getLogs") {
          const q = (r as unknown as { params: { fromBlock?: string; toBlock?: string; blockHash?: string }[] }).params[0]!;
          ranges.push(q.blockHash ? "hash" : `${parseInt(q.fromBlock!, 16)}-${parseInt(q.toBlock!, 16)}`);
        }
      }
    } catch { /* ignore */ }
    const up = http.request({ host: "127.0.0.1", port: ANVIL_PORT, method: "POST", path: "/", headers: { "content-type": "application/json" } }, (r) => {
      res.writeHead(r.statusCode ?? 500, { "content-type": "application/json" });
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    up.end(body);
  });
});
// SPIKE_PRIMARY_DOWN=1: the primary answers every call with HTTP 429 "Monthly
// capacity limit exceeded" (Alchemy over its cap, dev 2026-10-06) and the
// counting proxy above is the backup — the calls the backup (Infura) receives.
const PRIMARY_DOWN = process.env.SPIKE_PRIMARY_DOWN === "1";
const DOWN_PORT = PROXY_PORT + 2;
let downCalls = 0;
const down = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    downCalls++;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Monthly capacity limit exceeded." } }));
  });
});
const rpcEnv = () =>
  PRIMARY_DOWN
    ? { [`PONDER_RPC_URL_${CHAIN_ID}`]: `http://127.0.0.1:${DOWN_PORT}`, [`PONDER_RPC_FALLBACK_URL_${CHAIN_ID}`]: `http://127.0.0.1:${PROXY_PORT}` }
    : { [`PONDER_RPC_URL_${CHAIN_ID}`]: `http://127.0.0.1:${PROXY_PORT}` };
const take = () => { const c = counts; const r = ranges; counts = {}; ranges = []; return { c, r }; };

// Alchemy CU weights (approximate, for comparison only).
const CU: Record<string, number> = { eth_getLogs: 60, eth_getBlockByNumber: 16, eth_getBlockByHash: 16, eth_blockNumber: 10, eth_chainId: 0, eth_call: 26, eth_getTransactionReceipt: 15, eth_getBlockReceipts: 500 };
const cu = (c: Record<string, number>) => Object.entries(c).reduce((s, [m, n]) => s + n * (CU[m] ?? 20), 0);

const chain = defineChain({ id: CHAIN_ID, name: "anvil", nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${ANVIL_PORT}`] } } });
const pub = createPublicClient({ chain, transport: viemHttp(), pollingInterval: 50 });
const wallet = createWalletClient({ chain, transport: viemHttp() });
const control = createTestClient({ chain, transport: viemHttp(undefined, { timeout: 300_000 }), mode: "anvil" });

async function send(from: typeof operator, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await wallet.writeContract({ account: from, address, abi, functionName, args, chain } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
}

let ponder: ChildProcess | null = null;
let log = "";
function startPonder(schema: string, endBlock?: bigint) {
  log = "";
  ponder = spawn(path.join(indexerDir, "node_modules/.bin/ponder"), ["start", "--schema", schema, "--views-schema", "chain", "--port", String(PONDER_PORT)], {
    cwd: indexerDir,
    env: {
      ...process.env, APP_ENV: "local", INDEXER_CACHE: "1", INDEXER_DEPLOYMENT_FILE: deploymentFile,
      ...rpcEnv(), DATABASE_URL_DIRECT: spikeUrl,
      PONDER_TELEMETRY_DISABLED: "true", INDEXER_POLLING_INTERVAL_MS: "15000",
      ...(endBlock !== undefined ? { INDEXER_END_BLOCK: endBlock.toString(), PONDER_EXPERIMENTAL_DB: "platform" } : {}),
    },
  });
  ponder.stdout!.on("data", (d) => (log += d));
  ponder.stderr!.on("data", (d) => (log += d));
}
async function stopPonder() {
  if (!ponder) return;
  const p = ponder;
  ponder = null;
  if (p.exitCode !== null || p.signalCode !== null) return "exited by itself";
  const exited = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  await exited;
  return "stopped";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let spikeUrl = "";
async function main() {
  const admin = postgres(directUrl, { max: 1, onnotice: () => {} });
  await admin`drop database if exists cherrio_spike with (force)`;
  await admin`create database cherrio_spike`;
  const u = new URL(directUrl); u.pathname = "/cherrio_spike"; spikeUrl = u.toString();
  const db = postgres(spikeUrl, { max: 1, onnotice: () => {} });

  const anvil = spawn("anvil", ["--chain-id", String(CHAIN_ID), "--port", String(ANVIL_PORT), "--silent", "--block-time", String(BLOCK_TIME)]);
  await new Promise<void>((r) => proxy.listen(PROXY_PORT, "127.0.0.1", () => r()));
  if (PRIMARY_DOWN) await new Promise<void>((r) => down.listen(DOWN_PORT, "127.0.0.1", () => r()));
  for (let i = 0; i < 50; i++) { try { await pub.getChainId(); break; } catch { await sleep(200); } }
  const mock = JSON.parse(readFileSync(path.join(contractsDir, "out/MockUSDC.sol/MockUSDC.json"), "utf8")) as { deployedBytecode: { object: Hex } };
  await control.setCode({ address: USDC, bytecode: mock.deployedBytecode.object });
  execFileSync("forge", ["script", "script/DeployAmoy.s.sol", "--rpc-url", `http://127.0.0.1:${ANVIL_PORT}`, "--broadcast", "--use", "/opt/foundry/solc-0.8.24", "--offline"], {
    cwd: contractsDir, stdio: "pipe",
    env: { ...process.env, DEPLOYER_PRIVATE_KEY: toHex(operator.getHdKey().privateKey!), SAFE_ADDRESS: operator.address, TREASURY_ADDRESS: operator.address, DEPLOY_NAME: "local-test" },
  });
  const dep = JSON.parse(readFileSync(deploymentFile, "utf8")) as { contracts: { campaignFactory: { address: Address } } };
  const factory = dep.contracts.campaignFactory.address;
  let n = 0;
  async function activity() {
    n++;
    const offchainId = keccak256(toHex(`spike-${n}`));
    const now = (await pub.getBlock()).timestamp;
    await send(operator, factory, CampaignFactoryAbi as Abi, "createCampaign", [{ offchainId, beneficiary: ben.address, target: 1_000_000_000n, deadline: now + 30n * 86400n, beneficiaryType: 0 }]);
    const c = (await pub.readContract({ address: factory, abi: CampaignFactoryAbi, functionName: "campaigns", args: [offchainId] })) as Address;
    await send(operator, USDC, parseAbi(["function mint(address,uint256)"]) as Abi, "mint", [donor.address, 50_000_000n]);
    await send(donor, USDC, parseAbi(["function approve(address,uint256) returns (bool)"]) as Abi, "approve", [c, 50_000_000n]);
    await send(donor, c, CampaignAbi as Abi, "donate", [50_000_000n, 0, 0]);
    return c.toLowerCase();
  }
  for (let i = 0; i < Number(process.env.SPIKE_CAMPAIGNS ?? 1); i++) await activity();
  // In steps: one anvil_mine of 100,000 blocks outlasts viem's 10 s timeout.
  for (let left = Number(process.env.SPIKE_MINE ?? 3000); left > 0; left -= 5000) await control.mine({ blocks: Math.min(left, 5000) });
  take();

  // ── (a) realtime ───────────────────────────────────────────────────────────
  if (REALTIME_SECONDS > 0) {
    const start = await pub.getBlockNumber();
    startPonder("chain_rt");
    for (let t = 0; t < REALTIME_SECONDS; t += 5) await sleep(5000);
    const end = await pub.getBlockNumber();
    await stopPonder();
    const { c } = take();
    console.log(`\n== realtime: ${REALTIME_SECONDS}s, ${end - start} blocks`, c, `≈ ${cu(c)} CU, ${(cu(c) / Number(end - start)).toFixed(1)} CU/block`);
  }

  // ── (b) batch: the real runner ─────────────────────────────────────────────
  const INTERVAL = Number(process.env.SPIKE_INTERVAL ?? 20);
  const WINDOWS = Number(process.env.SPIKE_WINDOWS ?? 6);
  console.log(`\n== batch: runner every ${INTERVAL}s, ${WINDOWS} windows, chain head ${await pub.getBlockNumber()}`);
  const runnerPort = PONDER_PORT + 10;
  const runner = spawn(path.join(indexerDir, "node_modules/.bin/tsx"), ["scripts/batch.ts"], {
    cwd: indexerDir,
    env: {
      ...process.env, APP_ENV: "local", INDEXER_CACHE: "1", INDEXER_DEPLOYMENT_FILE: deploymentFile,
      ...rpcEnv(), DATABASE_URL_DIRECT: spikeUrl,
      PONDER_TELEMETRY_DISABLED: "true", INDEXER_SCHEMA: "chain_b", INDEXER_PORT: String(runnerPort),
      INDEXER_PONDER_PORT: String(runnerPort + 1), INDEXER_BATCH_INTERVAL_SECONDS: String(INTERVAL),
    },
  });
  let runnerLog = "";
  runner.stdout!.on("data", (d) => (runnerLog += d));
  runner.stderr!.on("data", (d) => (runnerLog += d));
  let total = 0;
  for (let w = 1; w <= WINDOWS; w++) {
    if (w === 3) await activity();
    await sleep(INTERVAL * 1000);
    const { c, r } = take();
    total += cu(c);
    console.log(`window ${w}:`, JSON.stringify(c), `= ${Object.values(c).reduce((a, b) => a + b, 0)} calls ≈ ${cu(c)} CU; getLogs ranges: ${r.join(" ")}`, PRIMARY_DOWN ? `(primary refused ${downCalls})` : "");
    downCalls = 0;
  }
  runner.kill("SIGTERM");
  await new Promise((r) => runner.once("exit", r));
  console.log((runnerLog.match(/\[indexer:batch\].*/g) ?? []).join("\n"));
  if (process.env.SPIKE_RUNNER_LOG) writeFileSync(process.env.SPIKE_RUNNER_LOG, runnerLog);
  console.log(`batch total ≈ ${total} CU over ${WINDOWS} windows`);

  anvil.kill();
  proxy.close();
  down.close();
  await db.end();
  await admin.end();
}
main().then(() => process.exit(0), (e) => { console.error(e, log.slice(-3000)); process.exit(1); });
