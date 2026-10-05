import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  createPublicClient, custom, decodeFunctionData, encodeErrorResult, getAddress, zeroAddress,
  UserRejectedRequestError, type EIP1193Provider, type Hex,
} from "viem";
import * as schema from "@cherrio/db";
import { EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { getDb } from "@/lib/db";
import { emergencyPoolAddress, loadSubpools } from "@/lib/admin/subpools";
import { sendCreateSubPool, toSubpoolFailure } from "@/lib/admin/subpool-client";
import { POST as sentRoute } from "@/app/api/admin/emergency-pool/subpools/sent/route";
import { cleanUp, createUser, ORIGIN, type TestUser } from "./helpers/organizations";
import { ensureFakeChain } from "./helpers/fake-chain";

// TASK-046: Admin → Emergency Pool. Sub-pool rows ⨝ indexed pools, the
// EmergencyPool address per environment, the audit record of a sent
// `createSubPool`, and the browser call (simulate, then send) against a fake
// EIP-1193 provider that answers like the EmergencyPool.

const POOL = getAddress("0xFa7Fd0253813E196d74575A8F93ABB91cd009517");
const OPERATOR = getAddress("0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7");
// Pool ids no other test file uses (the migration seeds 0–4; public-campaigns uses 9101–9103).
const IDS = [9201, 9202] as const;

interface World { chainId?: number; revert?: string; rejectSend?: boolean }

function fake(world: World = {}) {
  const simulated: { fn: string; args: readonly unknown[]; from: string }[] = [];
  const sent: { fn: string; args: readonly unknown[]; from: string; to: string }[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_chainId": return `0x${(world.chainId ?? 80002).toString(16)}`;
        case "eth_call": {
          const { data, from } = params![0] as { data: Hex; from?: string };
          const call = decodeFunctionData({ abi: EmergencyPoolAbi, data });
          simulated.push({ fn: call.functionName, args: call.args ?? [], from: getAddress(from ?? zeroAddress) });
          if (world.revert) {
            const err = { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: EmergencyPoolAbi, errorName: world.revert as never }) };
            throw Object.assign(new Error("execution reverted"), err);
          }
          return "0x";
        }
        case "eth_getBlockByNumber":
          return { number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: "0x6a0f0000",
                   baseFeePerGas: "0x" + (40n * 10n ** 9n).toString(16), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [],
                   uncles: [], nonce: "0x0000000000000000", difficulty: "0x0", logsBloom: "0x" + "00".repeat(256), miner: zeroAddress,
                   extraData: "0x", size: "0x1", stateRoot: `0x${"33".repeat(32)}`, receiptsRoot: `0x${"44".repeat(32)}`,
                   transactionsRoot: `0x${"55".repeat(32)}`, sha3Uncles: `0x${"66".repeat(32)}`, mixHash: `0x${"77".repeat(32)}` };
        case "eth_maxPriorityFeePerGas": return "0x" + 1_500_000_000n.toString(16);
        case "eth_sendTransaction": {
          if (world.rejectSend) throw new UserRejectedRequestError(new Error("User rejected the request."));
          const tx = params![0] as { data: Hex; from: string; to: string };
          const call = decodeFunctionData({ abi: EmergencyPoolAbi, data: tx.data });
          sent.push({ fn: call.functionName, args: call.args ?? [], from: getAddress(tx.from), to: getAddress(tx.to) });
          return `0x${"cd".repeat(32)}`;
        }
        default: throw new Error(`unexpected ${method}`);
      }
    },
  } as unknown as EIP1193Provider;
  return { provider, simulated, sent };
}

const reader = (p: EIP1193Provider) => createPublicClient({ transport: custom(p, { retryCount: 0 }) });
const call = (poolId: number) => ({ chainId: 80002, pool: POOL, poolId });

describe("sendCreateSubPool", () => {
  it("simulates createSubPool(id) from the Operator, then sends it to the EmergencyPool", async () => {
    const f = fake();
    const hash = await sendCreateSubPool(f.provider, OPERATOR, call(3), { reader: reader(f.provider) });
    expect(hash).toBe(`0x${"cd".repeat(32)}`);
    expect(f.simulated).toEqual([{ fn: "createSubPool", args: [3], from: OPERATOR }]);
    expect(f.sent).toEqual([{ fn: "createSubPool", args: [3], from: OPERATOR, to: POOL }]);
  });

  it("names the refusals and never reaches the wallet when the simulation fails", async () => {
    for (const [revert, code] of [["PoolAlreadyExists", "already_done"], ["NotOperator", "not_operator"]] as const) {
      const f = fake({ revert });
      const error = await sendCreateSubPool(f.provider, OPERATOR, call(1), { reader: reader(f.provider) }).catch((e: unknown) => e);
      expect(toSubpoolFailure(error)).toBe(code);
      expect(f.sent).toEqual([]);
    }
  });

  it("refuses the wrong network and reports a rejected signature", async () => {
    const wrong = fake({ chainId: 137 });
    const e1 = await sendCreateSubPool(wrong.provider, OPERATOR, call(1)).catch((e: unknown) => e);
    expect(toSubpoolFailure(e1)).toBe("wrong_network");
    expect(wrong.simulated).toEqual([]);

    const rejecting = fake({ rejectSend: true });
    const e2 = await sendCreateSubPool(rejecting.provider, OPERATOR, call(1), { reader: reader(rejecting.provider) }).catch((e: unknown) => e);
    expect(toSubpoolFailure(e2)).toBe("rejected");
  });
});

describe("emergencyPoolAddress", () => {
  it("reads the deployment on dev and LOCAL_EMERGENCY_POOL_ADDRESS on local", () => {
    expect(emergencyPoolAddress("dev", {})).toBe(POOL);
    expect(emergencyPoolAddress("local", { LOCAL_EMERGENCY_POOL_ADDRESS: POOL.toLowerCase() })).toBe(POOL);
    expect(emergencyPoolAddress("local", {})).toBeNull();
    expect(emergencyPoolAddress("local", { LOCAL_EMERGENCY_POOL_ADDRESS: "0x123" })).toBeNull();
  });
});

describe("Admin → Emergency Pool (Postgres, fake chain)", () => {
  let admin: TestUser;
  let member: TestUser;
  const db = () => getDb();

  async function post(user: TestUser | null, body: unknown, origin = ORIGIN) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
    if (user) headers.cookie = user.cookie;
    const res = await sentRoute(new Request(`${ORIGIN}/api/admin/emergency-pool/subpools/sent`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: res.status, body: res.status === 404 ? null : ((await res.json()) as Record<string, unknown>) };
  }

  beforeAll(async () => {
    await ensureFakeChain(db());
    admin = await createUser({ admin: true });
    member = await createUser();
    await db().insert(schema.emergencySubpools).values(
      IDS.map((poolId) => ({ poolId, slug: `test-subpool-${poolId}`, nameKey: `pool.test-${poolId}.name`, descriptionKey: "x" }))
    );
    // 9201 is on chain with a balance; 9202 only in the app.
    await db().execute(sql`insert into chain.pool (id, balance, total_contributed) values (9201, 12500000, 20000000) on conflict (id) do nothing`);
  });

  afterAll(async () => {
    await db().execute(sql`delete from chain.pool where id in (9201, 9202)`);
    await db().delete(schema.emergencySubpools).where(inArray(schema.emergencySubpools.poolId, [...IDS]));
    await cleanUp();
  });

  it("lists every sub-pool with its on-chain state; the migration rows 0–4 are there", async () => {
    const rows = await loadSubpools(db());
    expect(rows).not.toBeNull();
    expect(rows!.filter((r) => r.poolId <= 4).map((r) => r.slug)).toEqual(["general", "medical", "disasters", "animals", "climate"]);
    expect(rows!.filter((r) => IDS.includes(r.poolId as (typeof IDS)[number]))).toEqual([
      { poolId: 9201, slug: "test-subpool-9201", onChain: true, balance: 12_500_000n },
      { poolId: 9202, slug: "test-subpool-9202", onChain: false, balance: null },
    ]);
  });

  it("records a sent createSubPool for a seeded theme; refuses everyone else", async () => {
    const tx = `0x${"AB".repeat(32)}`;
    expect(await post(null, { poolId: 9202, txHash: tx })).toEqual({ status: 404, body: null });
    expect(await post(member, { poolId: 9202, txHash: tx })).toEqual({ status: 404, body: null });
    expect(await post(admin, { poolId: 9202, txHash: tx }, "https://evil.example")).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(await post(admin, { poolId: 0, txHash: tx })).toEqual({ status: 400, body: { error: "validation_failed" } });
    expect(await post(admin, { poolId: 9202, txHash: "0x12" })).toEqual({ status: 400, body: { error: "validation_failed" } });
    expect(await post(admin, { poolId: 9299, txHash: tx })).toEqual({ status: 404, body: null });
    expect(await post(admin, { poolId: 9202, txHash: tx })).toEqual({ status: 200, body: { ok: true } });

    const audit = await db()
      .select({ data: schema.auditLog.data, entityType: schema.auditLog.entityType })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.actorUserId, admin.id), eq(schema.auditLog.action, "pool.subpool_create.sent")));
    expect(audit).toEqual([
      { entityType: "emergency_subpool", data: { poolId: 9202, slug: "test-subpool-9202", txHash: tx.toLowerCase() } },
    ]);
  });
});
