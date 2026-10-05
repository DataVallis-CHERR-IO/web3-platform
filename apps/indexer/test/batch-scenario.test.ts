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
  factory = (JSON.parse(readFileSync(deploymentFile, "utf8")) as { contracts: { campaignFactory: { address: Address } } }).contracts.campaignFactory.address;

  const port = await freePort();
  runnerUrl = `http://127.0.0.1:${port}`;
  const { DATABASE_URL: _unused, ...rest } = process.env;
  runner = spawn(path.join(indexerDir, "node_modules/.bin/tsx"), ["scripts/batch.ts"], {
    cwd: indexerDir,
    env: {
      ...rest,
      APP_ENV: "local",
      INDEXER_DEPLOYMENT_FILE: deploymentFile,
      [`PONDER_RPC_URL_${CHAIN_ID}`]: rpcUrl,
      DATABASE_URL_DIRECT: url.toString(),
      PONDER_TELEMETRY_DISABLED: "true",
      INDEXER_SCHEMA: SCHEMA,
      INDEXER_PORT: String(port),
      INDEXER_PONDER_PORT: String(await freePort()),
      INDEXER_BATCH_INTERVAL_SECONDS: "5",
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
});
