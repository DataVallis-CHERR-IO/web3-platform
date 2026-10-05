/**
 * RPC cost measurement (TASK-048, ADR-055) — a local tool, not run in CI.
 * How many RPC calls does the indexer make (a) following every block (realtime)
 * and (b) in batch cycles (`ponder start` with INDEXER_END_BLOCK = head − 30,
 * stopped when it gets there, restarted on the same schema)?
 * Anvil (chain 80002, a block every SPIKE_BLOCK_TIME s) behind a counting proxy,
 * the real deploy script, real Postgres; prints calls per method and an
 * Alchemy-CU estimate per phase. Needs anvil/forge on PATH (solc at
 * /opt/foundry/solc-0.8.24, offline) and DATABASE_URL_DIRECT; uses its own
 * database `cherrio_spike`.
 *   DATABASE_URL_DIRECT=… SPIKE_REALTIME_SECONDS=60 SPIKE_CYCLES=5 [SPIKE_IDLE=1] tsx scripts/rpc-cost.ts
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
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
const CYCLES = Number(process.env.SPIKE_CYCLES ?? 4);
const CYCLE_SECONDS = Number(process.env.SPIKE_CYCLE_SECONDS ?? 40);
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
const proxy = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    try {
      const parsed = JSON.parse(body) as { method: string } | { method: string }[];
      for (const r of Array.isArray(parsed) ? parsed : [parsed]) counts[r.method] = (counts[r.method] ?? 0) + 1;
    } catch { /* ignore */ }
    const up = http.request({ host: "127.0.0.1", port: ANVIL_PORT, method: "POST", path: "/", headers: { "content-type": "application/json" } }, (r) => {
      res.writeHead(r.statusCode ?? 500, { "content-type": "application/json" });
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    up.end(body);
  });
});
const take = () => { const c = counts; counts = {}; return c; };

// Alchemy CU weights (approximate, for comparison only).
const CU: Record<string, number> = { eth_getLogs: 60, eth_getBlockByNumber: 16, eth_getBlockByHash: 16, eth_blockNumber: 10, eth_chainId: 0, eth_call: 26, eth_getTransactionReceipt: 15, eth_getBlockReceipts: 500 };
const cu = (c: Record<string, number>) => Object.entries(c).reduce((s, [m, n]) => s + n * (CU[m] ?? 20), 0);

const chain = defineChain({ id: CHAIN_ID, name: "anvil", nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${ANVIL_PORT}`] } } });
const pub = createPublicClient({ chain, transport: viemHttp(), pollingInterval: 50 });
const wallet = createWalletClient({ chain, transport: viemHttp() });
const control = createTestClient({ chain, transport: viemHttp(), mode: "anvil" });

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
      [`PONDER_RPC_URL_${CHAIN_ID}`]: `http://127.0.0.1:${PROXY_PORT}`, DATABASE_URL_DIRECT: spikeUrl,
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
async function indexedBlock(): Promise<number> {
  try {
    if ((await fetch(`http://127.0.0.1:${PONDER_PORT}/ready`)).status !== 200) return -1;
    const s = (await (await fetch(`http://127.0.0.1:${PONDER_PORT}/status`)).json()) as { cherrio?: { block?: { number?: number } } };
    return s.cherrio?.block?.number ?? -1;
  } catch { return -1; }
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
  await activity();
  take();

  // ── (a) realtime ───────────────────────────────────────────────────────────
  const start = await pub.getBlockNumber();
  startPonder("chain_rt");
  for (let t = 0; t < REALTIME_SECONDS; t += 5) {
    await sleep(5000);
    if (t === 30 || t === 90) await activity();
  }
  const end = await pub.getBlockNumber();
  await stopPonder();
  const rt = take();
  console.log(`\n== realtime: ${REALTIME_SECONDS}s, blocks ${start}→${end} (${end - start}), donations made: 2`);
  console.log(rt, `≈ ${cu(rt)} CU, ${(cu(rt) / Number(end - start)).toFixed(1)} CU/block`);

  // ── (b) batch ──────────────────────────────────────────────────────────────
  console.log(`\n== batch: ${CYCLES} cycles every ${CYCLE_SECONDS}s, end = head − 30`);
  const bStart = await pub.getBlockNumber();
  let total = 0;
  const totals: Record<string, number> = {};
  for (let i = 0; i < CYCLES; i++) {
    const idle = i >= 2 && process.env.SPIKE_IDLE === "1";
    const made = idle ? "0x" : await activity();
    await sleep(CYCLE_SECONDS * 1000);
    const head = await pub.getBlockNumber();
    const target = head - 30n;
    const t0 = Date.now();
    startPonder("chain_b", target);
    let reached = -1;
    for (let k = 0; k < 240 && reached < Number(target); k++) { await sleep(250); reached = await indexedBlock(); if (ponder?.exitCode != null) break; }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const recovered = log.includes("crash recovery");
    await sleep(1500);
    const how = await stopPonder();
    const c = take();
    total += cu(c);
    for (const [m, v] of Object.entries(c)) totals[m] = (totals[m] ?? 0) + v;
    const rows = await db`select count(*)::int as n from chain_b.donation where campaign = ${made}`.catch(() => [{ n: -1 }]);
    console.log(`cycle ${i + 1}: target ${target} reached ${reached} in ${secs}s, ${idle ? "IDLE " : ""}crash recovery: ${recovered}, ${how}, donation from this cycle indexed: ${rows[0]!.n}`, c, `≈ ${cu(c)} CU`);
    if (reached < Number(target)) console.log(log.slice(-3000));
  }
  const bEnd = await pub.getBlockNumber();
  console.log(`batch total over blocks ${bStart}→${bEnd} (${bEnd - bStart}):`, totals, `≈ ${total} CU, ${(total / Number(bEnd - bStart)).toFixed(1)} CU/block`);

  anvil.kill();
  proxy.close();
  await db.end();
  await admin.end();
}
main().then(() => process.exit(0), (e) => { console.error(e, log.slice(-3000)); process.exit(1); });
