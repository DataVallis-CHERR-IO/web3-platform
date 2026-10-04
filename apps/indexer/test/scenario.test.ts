/**
 * Scenario test: real Anvil chain + the unchanged TASK-004 deploy script + real Ponder
 * + real Postgres (a throwaway database created from DATABASE_URL_DIRECT).
 * Nothing is skipped: a missing anvil/forge binary or database fails the suite.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEventLogs,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CampaignAbi, CampaignFactoryAbi, EmergencyPoolAbi } from "@cherrio/contracts/abis";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexerDir = path.resolve(here, "..");
const contractsDir = path.resolve(here, "../../../packages/contracts");
const deploymentFile = path.join(contractsDir, "deployments/amoy-local-test.json");

// DeployAmoy.s.sol only runs on chain 80002 and hard-codes this USDC address.
const CHAIN_ID = 80002;
const USDC: Address = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";
const usdcAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

// Anvil's public default mnemonic — test accounts only.
const MNEMONIC = "test test test test test test test test test test test junk";
const account = (addressIndex: number) => mnemonicToAccount(MNEMONIC, { addressIndex });
const operator = account(0); // deployer + "Safe": OPERATOR and GUARDIAN
const [benA, benB, benC, d1, d2, d3] = [1, 2, 3, 4, 5, 6].map(account) as [
  Signer, Signer, Signer, Signer, Signer, Signer,
];
const treasury = account(9);
type Signer = ReturnType<typeof account>;

const usdc = (whole: number) => BigInt(whole) * 1_000_000n;
const DAY = 86_400;
// PlatformConfig.voteWindow default (ADR-045); the deploy script keeps the contract default.
const VOTE_WINDOW = 7 * DAY;
const REFUND = 0;
const TO_POOL = 1;

let anvil: ChildProcess;
let ponder: ChildProcess;
let ponderLog = "";
let admin: postgres.Sql;
let sql: postgres.Sql;
let testDb: string;
let testDbUrl: string;
let rpcUrl: string;
let ponderUrl: string;
let factory: Address;
let pool: Address;
let campaigns: Record<"a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i", Address>;
let pub: ReturnType<typeof createPublicClient>;
let wallet: ReturnType<typeof createWalletClient>;
let chainControl: ReturnType<typeof createTestClient>;

const TABLES = `chain_${Date.now().toString(36)}`;
const VIEWS = "chain";

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
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (ponder && ponder.exitCode !== null) {
      throw new Error(`ponder exited with ${ponder.exitCode}\n${ponderLog.slice(-4000)}`);
    }
    try {
      if (await check()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${what}\n${ponderLog.slice(-4000)}`, { cause: lastError });
}

async function send(from: Signer, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await wallet.writeContract({
    account: from,
    address,
    abi,
    functionName,
    args,
    chain: wallet.chain,
  } as Parameters<typeof wallet.writeContract>[0]);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}

const campaignTx = (from: Signer, address: Address, fn: string, args: unknown[] = []) =>
  send(from, address, CampaignAbi as Abi, fn, args);

async function donate(from: Signer, address: Address, whole: number, pref: number, subPool = 0) {
  await send(operator, USDC, usdcAbi as Abi, "mint", [from.address, usdc(whole)]);
  await send(from, USDC, usdcAbi as Abi, "approve", [address, usdc(whole)]);
  await campaignTx(from, address, "donate", [usdc(whole), pref, subPool]);
}

const poolTx = (from: Signer, fn: string, args: unknown[] = []) =>
  send(from, pool, EmergencyPoolAbi as Abi, fn, args);

async function donateToPool(from: Signer, poolId: number, whole: number) {
  await send(operator, USDC, usdcAbi as Abi, "mint", [from.address, usdc(whole)]);
  await send(from, USDC, usdcAbi as Abi, "approve", [pool, usdc(whole)]);
  await poolTx(from, "donate", [poolId, usdc(whole)]);
}

async function warp(seconds: number) {
  await chainControl.increaseTime({ seconds });
  await chainControl.mine({ blocks: 1 });
}

async function createCampaign(name: string, ben: Signer, whole: number, days: number, type: number) {
  const offchainId = keccak256(toHex(name));
  const now = (await pub.getBlock()).timestamp;
  await send(operator, factory, CampaignFactoryAbi as Abi, "createCampaign", [
    {
      offchainId,
      beneficiary: ben.address,
      target: usdc(whole),
      deadline: now + BigInt(days * DAY),
      beneficiaryType: type,
    },
  ]);
  return (await pub.readContract({
    address: factory,
    abi: CampaignFactoryAbi,
    functionName: "campaigns",
    args: [offchainId],
  })) as Address;
}

/** Waits until Ponder has indexed up to the current chain head. */
async function indexed() {
  const head = await pub.getBlockNumber();
  await until(`Ponder to index block ${head}`, async () => {
    if ((await fetch(`${ponderUrl}/ready`)).status !== 200) return false;
    const status = (await (await fetch(`${ponderUrl}/status`)).json()) as {
      cherrio?: { block?: { number?: number } };
    };
    return BigInt(status.cherrio?.block?.number ?? -1) >= head;
  });
}

const select = (table: string, where: Record<string, string | number> = {}) => {
  const conditions = Object.entries(where).reduce(
    (acc, [column, value]) => sql`${acc} and ${sql(column)} = ${value}`,
    sql`true`
  );
  return sql<Record<string, unknown>[]>`
    select * from ${sql(VIEWS)}.${sql(table)} where ${conditions} order by block_number, log_index`;
};
const lower = (address: Address) => address.toLowerCase();

function runReconcile() {
  return spawnSync(path.join(indexerDir, "node_modules/.bin/tsx"), ["scripts/reconcile.ts"], {
    cwd: indexerDir,
    encoding: "utf8",
    env: indexerEnv({ RECONCILE_SCHEMA: VIEWS }),
  });
}

function indexerEnv(extra: Record<string, string> = {}) {
  // DATABASE_URL is removed on purpose: the indexer must work from DATABASE_URL_DIRECT alone.
  const { DATABASE_URL: _unused, ...rest } = process.env;
  return {
    ...rest,
    APP_ENV: "local",
    INDEXER_DEPLOYMENT_FILE: deploymentFile,
    [`PONDER_RPC_URL_${CHAIN_ID}`]: rpcUrl,
    DATABASE_URL_DIRECT: testDbUrl,
    PONDER_TELEMETRY_DISABLED: "true",
    ...extra,
  };
}

beforeAll(async () => {
  // ── Throwaway database ─────────────────────────────────────────────────────
  const directUrl = process.env.DATABASE_URL_DIRECT;
  if (!directUrl) throw new Error("scenario test needs DATABASE_URL_DIRECT (direct Postgres)");
  admin = postgres(directUrl, { max: 1, onnotice: () => {} });
  testDb = `cherrio_indexer_test_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await admin`create database ${admin(testDb)}`;
  } catch (err) {
    throw new Error(
      `scenario test could not CREATE DATABASE ${testDb} with DATABASE_URL_DIRECT; ` +
        "the role needs CREATEDB (no fallback to the shared database)",
      { cause: err }
    );
  }
  const url = new URL(directUrl);
  url.pathname = `/${testDb}`;
  testDbUrl = url.toString();
  sql = postgres(testDbUrl, { max: 2, onnotice: () => {} });

  // ── Anvil + contracts ──────────────────────────────────────────────────────
  rpcUrl = `http://127.0.0.1:${await freePort()}`;
  anvil = spawn("anvil", ["--chain-id", String(CHAIN_ID), "--port", new URL(rpcUrl).port, "--silent"]);
  const anvilFailed = new Promise<never>((_, reject) =>
    anvil.once("error", (err) => reject(new Error("could not start anvil (is Foundry installed?)", { cause: err })))
  );
  const chain = defineChain({
    id: CHAIN_ID,
    name: "anvil-amoy",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  pub = createPublicClient({ chain, transport: http(), pollingInterval: 50 });
  wallet = createWalletClient({ chain, transport: http() });
  chainControl = createTestClient({ chain, transport: http(), mode: "anvil" });
  await Promise.race([anvilFailed, until("anvil", async () => (await pub.getChainId()) === CHAIN_ID, 15_000)]);

  execFileSync("forge", ["build"], { cwd: contractsDir, stdio: "pipe" });
  const mockUsdc = JSON.parse(
    readFileSync(path.join(contractsDir, "out/MockUSDC.sol/MockUSDC.json"), "utf8")
  ) as { deployedBytecode: { object: Hex } };
  await chainControl.setCode({ address: USDC, bytecode: mockUsdc.deployedBytecode.object });

  execFileSync("forge", ["script", "script/DeployAmoy.s.sol", "--rpc-url", rpcUrl, "--broadcast"], {
    cwd: contractsDir,
    stdio: "pipe",
    env: {
      ...process.env,
      DEPLOYER_PRIVATE_KEY: toHex(operator.getHdKey().privateKey!),
      SAFE_ADDRESS: operator.address,
      TREASURY_ADDRESS: treasury.address,
      DEPLOY_NAME: "local-test",
    },
  });
  const deployment = JSON.parse(readFileSync(deploymentFile, "utf8")) as {
    contracts: { campaignFactory: { address: Address }; emergencyPool: { address: Address } };
  };
  factory = deployment.contracts.campaignFactory.address;
  pool = deployment.contracts.emergencyPool.address;

  // ── Phase 1 (indexed as backfill) ──────────────────────────────────────────
  const a = await createCampaign("success-single", benA, 1000, 30, 0);
  const b = await createCampaign("milestones-reject", benB, 900, 30, 1);
  const c = await createCampaign("fail-to-pool", benC, 5000, 2, 0);

  // A: d2's 500 is clipped to the remaining 400 and completes the target.
  await donate(d1, a, 600, REFUND);
  await campaignTx(d1, a, "setPreference", [TO_POOL, 3]);
  await donate(d2, a, 500, TO_POOL, 7);
  await campaignTx(operator, a, "setPayoutMode", [0]);

  // B: milestones; round 0 is frozen for an hour, then approved.
  await donate(d1, b, 600, REFUND);
  await donate(d2, b, 300, TO_POOL);
  await campaignTx(operator, b, "setPayoutMode", [1]);
  await campaignTx(d3, b, "release");
  await campaignTx(benB, b, "submitEvidence", [keccak256(toHex("evidence-0"))]);
  await campaignTx(d1, b, "vote", [true]);
  await campaignTx(operator, b, "freeze");
  await warp(3600);
  await campaignTx(operator, b, "resolve", [true]);

  // C: stays far below the 10% threshold.
  await donate(d3, c, 100, REFUND);
  await donate(d2, c, 50, TO_POOL);
  await donate(d1, c, 20, REFUND);

  await warp(VOTE_WINDOW + DAY); // past A's release delay, B's vote window (+1 h frozen) and C's deadline
  await campaignTx(d3, a, "release");
  await campaignTx(d3, b, "closeVote");
  await campaignTx(d3, c, "finalize");

  // B round 1: 300 yes vs 600 no → REJECTED, 297 left for pro-rata settlement.
  await campaignTx(benB, b, "submitEvidence", [keccak256(toHex("evidence-1"))]);
  await campaignTx(d1, b, "vote", [false]);
  await campaignTx(d2, b, "vote", [true]);
  await warp(VOTE_WINDOW + 60);
  await campaignTx(d3, b, "closeVote");
  await campaignTx(d1, b, "claimRefund");
  await campaignTx(d3, b, "settleToPool", [d2.address]);

  await campaignTx(d3, c, "settleToPool", [d2.address]);
  await campaignTx(d1, c, "claimRefund");

  // ── Pool flows (still backfill) ────────────────────────────────────────────
  await poolTx(operator, "createSubPool", [7]);
  await donateToPool(d1, 7, 1000);
  await donateToPool(d2, 7, 500);
  await donateToPool(d3, 99, 25); // unknown sub-pool → general pool 0

  const d = await createCampaign("pool-funded", benA, 1000, 30, 0);
  const e = await createCampaign("filled-before-delivery", benA, 200, 30, 0);
  // G must still be LIVE when allocation 3 is closed one vote window later.
  const g = await createCampaign("pool-funded-then-failed", benC, 5000, 10, 0);
  const f = await createCampaign("milestones-silent-donors", benB, 900, 30, 1);
  const h = await createCampaign("allocations-refused", benA, 1000, 30, 0);
  const i = await createCampaign("filled-before-guardian-delivery", benA, 200, 30, 0);
  campaigns = { a, b, c, d, e, f, g, h, i };

  // F: nobody votes in either round, so the guardian decides both.
  await donate(d1, f, 600, REFUND);
  await donate(d2, f, 300, REFUND);
  await campaignTx(operator, f, "setPayoutMode", [1]);
  await campaignTx(d3, f, "release");
  await campaignTx(benB, f, "submitEvidence", [keccak256(toHex("f-evidence-0"))]);

  // Allocations from pool 7 (1500): 0 → D 400, 1 → E 100, 2 → D 700, 3 → G 50.
  const reason = keccak256(toHex("reason"));
  await poolTx(operator, "proposeAllocation", [7, d, usdc(400), reason]);
  await poolTx(operator, "proposeAllocation", [7, e, usdc(100), reason]);
  await poolTx(operator, "proposeAllocation", [7, d, usdc(700), reason]);
  await poolTx(operator, "proposeAllocation", [7, g, usdc(50), reason]);
  // 4 → H 60 (voted down), 5 → H 70 (guardian rejects), 6 → I 80 (guardian approves too late).
  await poolTx(operator, "proposeAllocation", [7, h, usdc(60), reason]);
  await poolTx(operator, "proposeAllocation", [7, h, usdc(70), reason]);
  await poolTx(operator, "proposeAllocation", [7, i, usdc(80), reason]);
  await poolTx(d1, "voteAllocation", [4n, false]);
  await poolTx(d2, "voteAllocation", [4n, true]);
  await poolTx(d1, "voteAllocation", [0n, true]);
  await poolTx(d2, "voteAllocation", [0n, false]);
  await poolTx(d1, "voteAllocation", [1n, true]);
  await poolTx(d1, "voteAllocation", [3n, true]);
  await donate(d3, e, 200, REFUND); // E succeeds before allocation 1 can be delivered

  await warp(VOTE_WINDOW + 60);
  await poolTx(d3, "closeAllocation", [0n]); // PASSED: D takes 400
  await poolTx(d3, "closeAllocation", [1n]); // DELIVERY_FAILED: E is no longer LIVE
  await poolTx(d3, "closeAllocation", [2n]); // no votes → NEEDS_REVIEW
  await poolTx(d3, "closeAllocation", [3n]); // PASSED: G takes 50
  await poolTx(operator, "resolveAllocation", [2n, true]); // D takes its last 600 of 700
  await poolTx(d3, "closeAllocation", [4n]); // 500 yes vs 1000 no → REJECTED
  await poolTx(d3, "closeAllocation", [5n]); // no votes → NEEDS_REVIEW
  await poolTx(d3, "closeAllocation", [6n]); // no votes → NEEDS_REVIEW
  await poolTx(operator, "resolveAllocation", [5n, false]); // RESOLVED_REJECT
  await donate(d3, i, 200, REFUND); // I succeeds before the guardian approves
  await poolTx(operator, "resolveAllocation", [6n, true]); // DELIVERY_FAILED, no AllocationResolved

  await campaignTx(d3, f, "closeVote"); // NEEDS_REVIEW
  await campaignTx(operator, f, "resolve", [true]); // guardian releases T2
  await campaignTx(benB, f, "submitEvidence", [keccak256(toHex("f-evidence-1"))]);
  await warp(VOTE_WINDOW + 60);
  await campaignTx(d3, f, "closeVote"); // NEEDS_REVIEW
  await campaignTx(operator, f, "resolve", [false]); // guardian rejects

  // ── Ponder ─────────────────────────────────────────────────────────────────
  const port = await freePort();
  ponderUrl = `http://127.0.0.1:${port}`;
  ponder = spawn(
    path.join(indexerDir, "node_modules/.bin/ponder"),
    ["start", "--schema", TABLES, "--views-schema", VIEWS, "--port", String(port)],
    { cwd: indexerDir, env: indexerEnv() }
  );
  ponder.stdout?.on("data", (chunk: Buffer) => (ponderLog += chunk.toString()));
  ponder.stderr?.on("data", (chunk: Buffer) => (ponderLog += chunk.toString()));
  await indexed();

  // ── Phase 2 (indexed in realtime) ──────────────────────────────────────────
  // d3 never claims, C is swept after 180 days; G fails and the pool reclaims its 50.
  await warp(181 * DAY);
  await campaignTx(d3, c, "sweepUnclaimed");
  await campaignTx(d3, g, "finalize");
  await poolTx(d3, "reclaimFromCampaign", [g]);
  await indexed();
});

afterAll(async () => {
  ponder?.kill("SIGTERM");
  anvil?.kill("SIGTERM");
  rmSync(deploymentFile, { force: true });
  await sql?.end();
  if (admin) {
    await admin`drop database if exists ${admin(testDb)} with (force)`;
    await admin.end();
  }
});

describe("indexer scenario (Anvil + Ponder + Postgres)", () => {
  it("A success-single: clipped donation, preference change, single payout", async () => {
    const [row] = await select("campaign", { address: lower(campaigns.a) });
    expect(row).toMatchObject({
      offchain_id: keccak256(toHex("success-single")),
      beneficiary: lower(benA.address),
      beneficiary_type: 0,
      target: String(usdc(1000)),
      state: "COMPLETED",
      total_raised: String(usdc(1000)),
      payout_mode: 0,
      released: String(usdc(990)),
      fee_paid: String(usdc(10)),
      tranches_released: 0,
      swept: false,
      // PlatformConfig snapshot read at creation (TASK-033b): the deploy keeps the source defaults (ADR-045).
      snap_fee_bps: 100,
      snap_success_threshold_bps: 1000,
      snap_refund_sweep_delay: 180 * DAY,
      snap_vote_window: VOTE_WINDOW,
      snap_quorum_bps: 2500,
      snap_approval_bps: 5100,
      snap_release_delay: 3 * DAY,
    });

    const donations = await select("donation", { campaign: lower(campaigns.a) });
    expect(donations.map((d) => [d.donor, d.amount, d.preference, d.sub_pool_id])).toEqual([
      [lower(d1.address), String(usdc(600)), REFUND, 0],
      [lower(d2.address), String(usdc(400)), TO_POOL, 7],
    ]);

    const [donor1] = await select0("campaign_donor", campaigns.a, d1.address);
    expect(donor1).toMatchObject({ donated: String(usdc(600)), preference: TO_POOL, sub_pool_id: 3, settled: false });

    const tranches = await select("tranche_release", { campaign: lower(campaigns.a) });
    expect(tranches.map((t) => [t.tranche_index, t.amount, t.fee, t.beneficiary])).toEqual([
      [0, String(usdc(990)), String(usdc(10)), lower(benA.address)],
    ]);
  });

  it("B milestones-reject: two tranches, freeze/resolve, rejection, pro-rata settlement", async () => {
    const [row] = await select("campaign", { address: lower(campaigns.b) });
    expect(row).toMatchObject({
      beneficiary_type: 1,
      state: "REJECTED",
      total_raised: String(usdc(900)),
      payout_mode: 1,
      released: String(usdc(594)),
      fee_paid: String(usdc(9)),
      tranches_released: 2,
      current_round: 1,
      prev_state: "VOTING",
      rejected_remainder: String(usdc(297)),
      total_refunded: String(usdc(198)),
      total_sent_to_pool: String(usdc(99)),
    });

    const tranches = await select("tranche_release", { campaign: lower(campaigns.b) });
    expect(tranches.map((t) => [t.tranche_index, t.amount, t.fee])).toEqual([
      [0, String(usdc(297)), String(usdc(9))],
      [1, String(usdc(297)), "0"],
    ]);

    const rounds = await select("vote_round", { campaign: lower(campaigns.b) });
    expect(rounds.map((r) => [r.round, r.yes_votes, r.no_votes, r.outcome])).toEqual([
      [0, String(usdc(600)), "0", "PAYING"],
      [1, String(usdc(300)), String(usdc(600)), "REJECTED"],
    ]);

    const votes = await select("vote", { campaign: lower(campaigns.b) });
    expect(votes.map((v) => [v.round, v.voter, v.approve, v.weight])).toEqual([
      [0, lower(d1.address), true, String(usdc(600))],
      [1, lower(d1.address), false, String(usdc(600))],
      [1, lower(d2.address), true, String(usdc(300))],
    ]);

    const actions = await select("guardian_action", { campaign: lower(campaigns.b) });
    expect(actions.map((g) => [g.kind, g.approve, g.result_state, g.actor])).toEqual([
      ["FREEZE", null, "FROZEN", lower(operator.address)],
      ["RESOLVE", true, "VOTING", lower(operator.address)],
    ]);
    // Round 0 was extended by exactly the time spent frozen.
    const frozenFor = BigInt(actions[1]!.block_time as string) - BigInt(actions[0]!.block_time as string);
    expect(BigInt(rounds[0]!.vote_end as string)).toBe(
      BigInt(rounds[0]!.block_time as string) + BigInt(VOTE_WINDOW) + frozenFor
    );

    const refunds = await select("refund", { campaign: lower(campaigns.b) });
    expect(refunds.map((r) => [r.donor, r.amount])).toEqual([[lower(d1.address), String(usdc(198))]]);
    const [donor2] = await select0("campaign_donor", campaigns.b, d2.address);
    expect(donor2).toMatchObject({ donated: String(usdc(300)), preference: TO_POOL, settled: true });
  });

  it("C fail-to-pool: failed, settled, refunded, then swept in realtime", async () => {
    const [row] = await select("campaign", { address: lower(campaigns.c) });
    expect(row).toMatchObject({
      state: "FAILED",
      total_raised: String(usdc(170)),
      payout_mode: null,
      released: "0",
      total_refunded: String(usdc(20)),
      total_sent_to_pool: String(usdc(150)),
      swept: true,
    });
    expect(row!.settlement_start).toBe(row!.end_time);

    const donors = await sql<Record<string, unknown>[]>`
      select donor, settled from ${sql(VIEWS)}.campaign_donor
      where campaign = ${lower(campaigns.c)} order by donor`;
    const settled = Object.fromEntries(donors.map((d) => [d.donor, d.settled]));
    expect(settled).toEqual({
      [lower(d1.address)]: true, // claimed refund
      [lower(d2.address)]: true, // settled to pool
      [lower(d3.address)]: false, // never claimed → swept
    });
  });

  it("F silent donors: NEEDS_REVIEW twice, guardian releases T2 then rejects", async () => {
    const [row] = await select("campaign", { address: lower(campaigns.f) });
    expect(row).toMatchObject({
      state: "REJECTED",
      released: String(usdc(594)),
      fee_paid: String(usdc(9)),
      tranches_released: 2,
      current_round: 1,
      rejected_remainder: String(usdc(297)),
      total_refunded: "0",
    });
    const rounds = await select("vote_round", { campaign: lower(campaigns.f) });
    expect(rounds.map((r) => [r.round, r.yes_votes, r.no_votes, r.outcome])).toEqual([
      [0, "0", "0", "NEEDS_REVIEW"],
      [1, "0", "0", "NEEDS_REVIEW"],
    ]);
    const actions = await select("guardian_action", { campaign: lower(campaigns.f) });
    expect(actions.map((g) => [g.kind, g.approve, g.result_state])).toEqual([
      ["RESOLVE", true, "PAYING"],
      ["RESOLVE", false, "REJECTED"],
    ]);
    const tranches = await select("tranche_release", { campaign: lower(campaigns.f) });
    expect(tranches.map((t) => [t.tranche_index, t.amount])).toEqual([
      [0, String(usdc(297))],
      [1, String(usdc(297))],
    ]);
  });

  it("pool: balances, contributions and transfers", async () => {
    const pools = await sql<Record<string, unknown>[]>`select * from ${sql(VIEWS)}.pool order by id`;
    expect(pools).toEqual([
      // 99 + 50 settled, 100 swept (no contributor credit), 25 direct
      { id: 0, balance: String(usdc(274)), total_contributed: String(usdc(174)) },
      // 1500 − 400 − 600 − 50 delivered + 50 reclaimed; allocations 1, 4, 5, 6 returned in full
      { id: 7, balance: String(usdc(500)), total_contributed: String(usdc(1500)) },
    ]);

    const contributions = await select("pool_contribution");
    expect(contributions.map((c) => [c.source, c.pool_id, c.donor, c.amount, c.campaign])).toEqual([
      ["CAMPAIGN", 0, lower(d2.address), String(usdc(99)), lower(campaigns.b)],
      ["CAMPAIGN", 0, lower(d2.address), String(usdc(50)), lower(campaigns.c)],
      ["DIRECT", 7, lower(d1.address), String(usdc(1000)), null],
      ["DIRECT", 7, lower(d2.address), String(usdc(500)), null],
      ["DIRECT", 0, lower(d3.address), String(usdc(25)), null],
    ]);

    const transfers = await select("pool_transfer");
    expect(transfers.map((t) => [t.kind, t.pool_id, t.campaign, t.donor, t.amount])).toEqual([
      ["SETTLE", 0, lower(campaigns.b), lower(d2.address), String(usdc(99))],
      ["SETTLE", 0, lower(campaigns.c), lower(d2.address), String(usdc(50))],
      ["SWEEP", 0, lower(campaigns.c), null, String(usdc(100))],
      ["RECLAIM", 7, lower(campaigns.g), null, String(usdc(50))],
    ]);
  });

  it("allocations: passed, delivery failed, guardian-resolved with clipping, reclaimed", async () => {
    const allocations = await sql<Record<string, unknown>[]>`
      select * from ${sql(VIEWS)}.allocation order by id`;
    expect(
      allocations.map((a) => [a.id, a.campaign, a.amount, a.delivered, a.state, a.yes_votes, a.no_votes])
    ).toEqual([
      ["0", lower(campaigns.d), String(usdc(400)), String(usdc(400)), "PASSED", String(usdc(1000)), String(usdc(500))],
      ["1", lower(campaigns.e), String(usdc(100)), null, "DELIVERY_FAILED", String(usdc(1000)), "0"],
      ["2", lower(campaigns.d), String(usdc(700)), String(usdc(600)), "RESOLVED_PASS", "0", "0"],
      ["3", lower(campaigns.g), String(usdc(50)), String(usdc(50)), "PASSED", String(usdc(1000)), "0"],
      ["4", lower(campaigns.h), String(usdc(60)), null, "REJECTED", String(usdc(500)), String(usdc(1000))],
      ["5", lower(campaigns.h), String(usdc(70)), null, "RESOLVED_REJECT", "0", "0"],
      ["6", lower(campaigns.i), String(usdc(80)), null, "DELIVERY_FAILED", "0", "0"],
    ]);

    const votes = await sql<Record<string, unknown>[]>`
      select * from ${sql(VIEWS)}.allocation_vote order by allocation_id, weight desc`;
    expect(votes.map((v) => [v.allocation_id, v.voter, v.approve, v.weight])).toEqual([
      ["0", lower(d1.address), true, String(usdc(1000))],
      ["0", lower(d2.address), false, String(usdc(500))],
      ["1", lower(d1.address), true, String(usdc(1000))],
      ["3", lower(d1.address), true, String(usdc(1000))],
      ["4", lower(d1.address), false, String(usdc(1000))],
      ["4", lower(d2.address), true, String(usdc(500))],
    ]);

    // Allocation 6 failed inside resolveAllocation: the contract emits no AllocationResolved.
    const resolved = await select("guardian_action", { kind: "ALLOCATION_RESOLVE" });
    expect(resolved.map((g) => [g.allocation_id, g.approve, g.result_state])).toEqual([
      ["2", true, "RESOLVED_PASS"],
      ["5", false, "RESOLVED_REJECT"],
    ]);
    // Refused and failed allocations returned their full amount: H raised nothing.
    const [hRow] = await select("campaign", { address: lower(campaigns.h) });
    expect(hRow).toMatchObject({ state: "LIVE", total_raised: "0", pool_donated: "0", funding_pool_id: 7 });

    // Donated from the pool: D is fully pool-funded, G got 50 and gave it back.
    const [dRow] = await select("campaign", { address: lower(campaigns.d) });
    expect(dRow).toMatchObject({
      state: "SUCCEEDED",
      total_raised: String(usdc(1000)),
      pool_donated: String(usdc(1000)),
      funding_pool_id: 7,
    });
    const [gRow] = await select("campaign", { address: lower(campaigns.g) });
    expect(gRow).toMatchObject({
      state: "FAILED",
      pool_donated: String(usdc(50)),
      total_refunded: String(usdc(50)),
      funding_pool_id: 7,
    });
    const [poolAsDonor] = await select0("campaign_donor", campaigns.g, pool);
    expect(poolAsDonor).toMatchObject({ donated: String(usdc(50)), preference: REFUND, settled: true });
  });

  it("every event of the three contracts occurred on chain and left a row", async () => {
    // OpenZeppelin's Initializable event: emitted by every clone, carries no platform state.
    const NOT_INDEXED = ["Initialized"];
    const eventNames = (abi: Abi) =>
      abi.flatMap((item) => (item.type === "event" && !NOT_INDEXED.includes(item.name) ? [item.name] : []));
    const expected = [CampaignFactoryAbi, CampaignAbi, EmergencyPoolAbi].flatMap((abi) => eventNames(abi as Abi));
    expect(expected).toHaveLength(23);

    const logs = await pub.getLogs({ address: [factory, pool, ...Object.values(campaigns)], fromBlock: 0n });
    const onChain = new Set<string>();
    for (const [abi, emitters] of [
      [CampaignFactoryAbi, [factory]],
      [EmergencyPoolAbi, [pool]],
      [CampaignAbi, Object.values(campaigns)],
    ] as [Abi, Address[]][]) {
      const own = logs.filter((log) => emitters.some((emitter) => lower(emitter) === lower(log.address)));
      for (const log of parseEventLogs({ abi, logs: own })) onChain.add(log.eventName);
    }
    for (const name of NOT_INDEXED) onChain.delete(name);
    expect([...onChain].sort()).toEqual([...expected].sort());

    // event → a row (or column value) only that event's handler can produce
    const evidence: Record<string, [table: string, where: string]> = {
      CampaignCreated: ["campaign", "true"],
      Donated: ["donation", "true"],
      PreferenceSet: ["campaign_donor", "sub_pool_id = 3"],
      Finalized: ["campaign", "end_time > 0"],
      PayoutModeSet: ["campaign", "payout_mode is not null"],
      TrancheReleased: ["tranche_release", "true"],
      Refunded: ["refund", "true"],
      SentToPool: ["campaign_donor", "settled and preference = 1"],
      Swept: ["campaign", "swept"],
      EvidenceSubmitted: ["vote_round", "true"],
      Voted: ["vote", "true"],
      VoteClosed: ["vote_round", "outcome is not null"],
      Frozen: ["guardian_action", "kind = 'FREEZE'"],
      Resolved: ["guardian_action", "kind = 'RESOLVE'"],
      SubPoolCreated: ["pool", "id = 7"],
      PoolDonated: ["pool_contribution", "source = 'DIRECT'"],
      CampaignInflow: ["pool_transfer", "kind in ('SETTLE', 'SWEEP')"],
      AllocationProposed: ["allocation", "true"],
      AllocationVoted: ["allocation_vote", "true"],
      AllocationClosed: ["allocation", "state = 'PASSED'"],
      AllocationDeliveryFailed: ["allocation", "state = 'DELIVERY_FAILED'"],
      AllocationResolved: ["guardian_action", "kind = 'ALLOCATION_RESOLVE'"],
      ReclaimedFromCampaign: ["pool_transfer", "kind = 'RECLAIM'"],
    };
    expect(Object.keys(evidence).sort()).toEqual([...expected].sort());
    const missing: string[] = [];
    for (const [event, [table, where]] of Object.entries(evidence)) {
      const rows = await sql`select 1 from ${sql(VIEWS)}.${sql(table)} where ${sql.unsafe(where)} limit 1`;
      if (rows.length === 0) missing.push(event);
    }
    expect(missing).toEqual([]);
  });

  it("writes exactly the expected number of rows", async () => {
    const counts: Record<string, number> = {};
    for (const table of [
      "campaign", "campaign_donor", "donation", "vote_round", "vote", "tranche_release", "refund",
      "guardian_action", "pool", "pool_contribution", "pool_transfer", "allocation", "allocation_vote",
    ]) {
      const rows = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(VIEWS)}.${sql(table)}`;
      counts[table] = rows[0]!.n;
    }
    expect(counts).toEqual({
      campaign: 9, campaign_donor: 13, donation: 14, vote_round: 4, vote: 3, tranche_release: 5,
      refund: 3, guardian_action: 6,
      pool: 2, pool_contribution: 5, pool_transfer: 4, allocation: 7, allocation_vote: 6,
    });
  });

  it("creates only its own schemas (ADR-026)", async () => {
    const schemas = await sql<{ nspname: string }[]>`
      select nspname from pg_namespace
      where nspname not like 'pg\\_%' and nspname <> 'information_schema' order by 1`;
    expect(schemas.map((s) => s.nspname)).toEqual([VIEWS, TABLES, "ponder_sync", "public"].sort());
    const kinds = await sql<{ kind: string }[]>`
      select c.relkind as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${VIEWS} and c.relname = 'campaign'`;
    expect(kinds.map((k) => k.kind)).toEqual(["v"]);
  });

  it("reconcile: zero mismatches against the contract views", async () => {
    const result = runReconcile();
    console.log(result.stdout + result.stderr);
    expect(result.stdout).toContain("mismatches: 0");
    // Pins the Ponder checkpoint format: reconcile must read the block Ponder reports.
    const status = (await (await fetch(`${ponderUrl}/status`)).json()) as {
      cherrio: { block: { number: number } };
    };
    expect(status.cherrio.block.number).toBe(Number(await pub.getBlockNumber()));
    expect(result.stdout).toContain(`block=${status.cherrio.block.number} `);
    expect(result.status).toBe(0);
  });

  it("reconcile: one corrupted row gives exactly one mismatch and exit code 1", async () => {
    const where = sql`address = ${lower(campaigns.a)}`;
    // Ponder's live-query trigger only works inside Ponder's own session.
    await sql`alter table ${sql(TABLES)}.campaign disable trigger user`;
    await sql`update ${sql(TABLES)}.campaign set total_raised = total_raised + 1 where ${where}`;
    try {
      const result = runReconcile();
      console.log(result.stdout + result.stderr);
      expect(result.stdout).toContain(`MISMATCH campaign ${lower(campaigns.a)} total_raised`);
      expect(result.stdout).toContain("mismatches: 1");
      expect(result.status).toBe(1);
    } finally {
      await sql`update ${sql(TABLES)}.campaign set total_raised = total_raised - 1 where ${where}`;
      await sql`alter table ${sql(TABLES)}.campaign enable trigger user`;
    }
  });

  // ── RPC key never reaches the output (TASK-027) ────────────────────────────
  const FAKE_KEY = "TESTKEY1234567890";
  const FAKE_RPC = `https://example.invalid/v2/${FAKE_KEY}`;

  it("reconcile with a failing RPC prints the error without the key and exits 1", () => {
    const result = spawnSync(path.join(indexerDir, "node_modules/.bin/tsx"), ["scripts/reconcile.ts"], {
      cwd: indexerDir,
      encoding: "utf8",
      env: indexerEnv({ RECONCILE_SCHEMA: VIEWS, [`PONDER_RPC_URL_${CHAIN_ID}`]: FAKE_RPC }),
    });
    const output = result.stdout + result.stderr;
    expect(output).toContain("https://example.invalid/v2/***");
    expect(output).not.toContain(FAKE_KEY);
    expect(result.status).toBe(1);
  });

  it("ponder start with a failing RPC logs its errors without the key", async () => {
    const child = spawn(
      path.join(indexerDir, "node_modules/.bin/ponder"),
      ["start", "--schema", `${TABLES}_redact`, "--port", String(await freePort())],
      { cwd: indexerDir, env: indexerEnv({ [`PONDER_RPC_URL_${CHAIN_ID}`]: FAKE_RPC }) }
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    try {
      // Wait until Ponder has printed at least one RPC error (they carry viem's "URL: …" line).
      const deadline = Date.now() + 60_000;
      while (!output.includes("example.invalid/v2/") && child.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      await new Promise((r) => setTimeout(r, 3_000)); // a few more seconds of retries
    } finally {
      child.kill("SIGTERM");
    }
    expect(output).toContain("https://example.invalid/v2/***");
    expect(output).not.toContain(FAKE_KEY);
  });
});

function select0(table: string, campaign: Address, donor: Address) {
  return sql<Record<string, unknown>[]>`
    select * from ${sql(VIEWS)}.${sql(table)}
    where campaign = ${lower(campaign)} and donor = ${lower(donor)}`;
}
