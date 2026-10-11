import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { encodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { consoleContracts } from "@/lib/contracts/changes";
import { encodeSetter, paramSpec } from "@/lib/contracts/config-params";
import { ZERO_BYTES32 } from "@/lib/contracts/timelock";
import {
  callRisk, changePhase, describeCall, loadScheduledChanges, pendingMoneyChanges, worstRisk,
} from "@/lib/contracts/scheduled";
import { ensureFakeChain } from "./helpers/fake-chain";
import { cleanUp, createUser, type TestUser } from "./helpers/organizations";

// TASK-023d-2 (security review M-02): the public list of every operation on the
// TimelockController, whoever scheduled it, and the notices built on it.

const { contractChanges } = schema;
process.env.APP_ENV ??= "local";
const contracts = consoleContracts("dev")!;
const hex32 = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const STRANGER: Address = "0x00000000000000000000000000000000000000aa";
const roles = parseAbi([
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function updateDelay(uint256 newDelay)",
]);
const grant = (role: Hex, account: Address) => encodeFunctionData({ abi: roles, functionName: "grantRole", args: [role, account] });

describe("describeCall", () => {
  it("a PlatformConfig setter in words; Emergency Pool and treasury are money changes", () => {
    const pool = describeCall(contracts.platformConfig, encodeSetter(paramSpec("emergencyPool"), STRANGER), contracts);
    expect(pool).toEqual({ kind: "setting", key: "emergencyPool", to: "0x00000000000000000000000000000000000000AA" });
    expect(callRisk(pool)).toBe("money");
    const treasury = describeCall(contracts.platformConfig, encodeSetter(paramSpec("treasury"), STRANGER), contracts);
    expect(callRisk(treasury)).toBe("money");
    const fee = describeCall(contracts.platformConfig, encodeSetter(paramSpec("feeBps"), 300n), contracts);
    expect(fee).toEqual({ kind: "setting", key: "feeBps", to: "300" });
    expect(callRisk(fee)).toBe("setting");
  });

  it("role changes name the role, unknown role ids stay visible", () => {
    const op = describeCall(contracts.platformConfig, grant(keccak256(toHex("OPERATOR_ROLE")), STRANGER), contracts);
    expect(op).toMatchObject({ kind: "role", action: "grant", role: "OPERATOR_ROLE", on: "platformConfig" });
    expect(callRisk(op)).toBe("roles");
    const admin = describeCall(contracts.timelock, encodeFunctionData({ abi: roles, functionName: "revokeRole", args: [ZERO_BYTES32, STRANGER] }), contracts);
    expect(admin).toMatchObject({ kind: "role", action: "revoke", role: "DEFAULT_ADMIN_ROLE", on: "timelock" });
    const odd = hex32();
    expect(describeCall(contracts.platformConfig, grant(odd, STRANGER), contracts)).toMatchObject({ role: null, roleId: odd });
  });

  it("renouncing a role is a role change", () => {
    const call = describeCall(contracts.platformConfig, encodeFunctionData({ abi: parseAbi(["function renounceRole(bytes32 role, address callerConfirmation)"]), functionName: "renounceRole", args: [ZERO_BYTES32, contracts.timelock] }), contracts);
    expect(call).toMatchObject({ kind: "role", action: "renounce", role: "DEFAULT_ADMIN_ROLE" });
    expect(callRisk(call)).toBe("roles");
  });

  it("setEmergencyPool with extra bytes after the address still runs on chain: unknown, but marked as money (review finding)", () => {
    const data = `${encodeSetter(paramSpec("emergencyPool"), STRANGER)}${"ab".repeat(4)}` as Hex;
    const call = describeCall(contracts.platformConfig, data, contracts);
    expect(call.kind).toBe("unknown");
    expect(callRisk(call)).toBe("money");
  });

  it("a shorter timelock delay weakens the watch: marked like a role change", () => {
    const call = describeCall(contracts.timelock, encodeFunctionData({ abi: roles, functionName: "updateDelay", args: [60n] }), contracts);
    expect(call).toEqual({ kind: "delay", seconds: 60n });
    expect(callRisk(call)).toBe("roles");
  });

  it("anything else is unknown — also a known setter sent to another contract", () => {
    const foreign = describeCall(STRANGER, encodeSetter(paramSpec("emergencyPool"), STRANGER), contracts);
    expect(foreign).toMatchObject({ kind: "unknown", selector: encodeSetter(paramSpec("emergencyPool"), STRANGER).slice(0, 10) });
    expect(describeCall(contracts.platformConfig, "0xdeadbeef", contracts)).toMatchObject({ kind: "unknown", selector: "0xdeadbeef" });
    // A setter with an out-of-bounds value is not the "known" call either.
    expect(describeCall(contracts.platformConfig, encodeSetter(paramSpec("feeBps"), 500n).replace(/1f4$/, "fff") as Hex, contracts).kind).toBe("unknown");
    expect(worstRisk([describeCall(STRANGER, "0x12345678", contracts)])).toBe("unknown");
  });

  it("worst risk first: money before roles before unknown before settings", () => {
    const fee = describeCall(contracts.platformConfig, encodeSetter(paramSpec("feeBps"), 300n), contracts);
    const unknown = describeCall(STRANGER, "0x12345678", contracts);
    const role = describeCall(contracts.platformConfig, grant(ZERO_BYTES32, STRANGER), contracts);
    const money = describeCall(contracts.platformConfig, encodeSetter(paramSpec("treasury"), STRANGER), contracts);
    expect(worstRisk([fee, unknown, role, money])).toBe("money");
    expect(worstRisk([fee, unknown, role])).toBe("roles");
    expect(worstRisk([fee, unknown])).toBe("unknown");
    expect(worstRisk([fee])).toBe("setting");
  });
});

describe("changePhase", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  it("waiting until ready_at, ready from then; executed and cancelled as indexed", () => {
    expect(changePhase("WAITING", new Date("2026-10-11T12:00:01Z"), now)).toBe("waiting");
    expect(changePhase("WAITING", now, now)).toBe("ready");
    expect(changePhase("EXECUTED", new Date("2027-01-01Z"), now)).toBe("executed");
    expect(changePhase("CANCELLED", new Date("2027-01-01Z"), now)).toBe("cancelled");
  });
});

describe("loadScheduledChanges (fake chain views)", () => {
  const db = getDb();
  let admin: TestUser;
  const now = new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const ops = { waitingMoney: hex32(), readyRole: hex32(), executed: hex32(), cancelledMoney: hex32(), fromConsole: hex32() };
  const allIds = Object.values(ops);

  const txOf = new Map<string, Hex>();
  async function insertOp(id: Hex, state: string, readyAt: number, block: number, calls: { target: string; data: Hex }[]) {
    const tx = hex32();
    txOf.set(id, tx);
    await db.execute(sql`
      insert into chain.timelock_operation (id, calls, delay, ready_at, state, block_number, block_time, tx_hash,
        executed_tx_hash, executed_block_time, cancelled_tx_hash, cancelled_block_time)
      values (${id}, ${calls.length}, 300, ${readyAt}, ${state}, ${block}, ${readyAt - 300}, ${tx},
        ${state === "EXECUTED" ? hex32() : null}, ${state === "EXECUTED" ? readyAt + 10 : null},
        ${state === "CANCELLED" ? hex32() : null}, ${state === "CANCELLED" ? readyAt - 100 : null})`);
    for (const [index, c] of calls.entries()) {
      await db.execute(sql`insert into chain.timelock_call (op_id, index, target, data) values (${id}, ${index}, ${c.target.toLowerCase()}, ${c.data})`);
    }
  }

  beforeAll(async () => {
    await ensureFakeChain(db);
    admin = await createUser({ admin: true });
    const pc = contracts.platformConfig;
    // Block numbers far above anything else in the shared test database keep these first.
    await insertOp(ops.waitingMoney, "WAITING", nowS + 3600, 9_000_000_005, [
      { target: pc, data: encodeSetter(paramSpec("feeBps"), 300n) },
      { target: pc, data: encodeSetter(paramSpec("emergencyPool"), STRANGER) },
    ]);
    await insertOp(ops.readyRole, "WAITING", nowS - 60, 9_000_000_004, [{ target: pc, data: grant(ZERO_BYTES32, STRANGER) }]);
    await insertOp(ops.executed, "EXECUTED", nowS - 7200, 9_000_000_003, [{ target: pc, data: encodeSetter(paramSpec("treasury"), STRANGER) }]);
    await insertOp(ops.cancelledMoney, "CANCELLED", nowS + 3600, 9_000_000_002, [{ target: pc, data: encodeSetter(paramSpec("treasury"), STRANGER) }]);
    await insertOp(ops.fromConsole, "WAITING", nowS + 600, 9_000_000_001, [{ target: pc, data: encodeSetter(paramSpec("voteWindow"), 3600n) }]);
    await db.insert(contractChanges).values({
      chainId: contracts.chainId, timelock: contracts.timelock.toLowerCase(), operationId: ops.fromConsole,
      targets: [pc.toLowerCase()], payloads: [encodeSetter(paramSpec("voteWindow"), 3600n)],
      predecessor: ZERO_BYTES32, salt: hex32(), delaySeconds: 300, summary: [], scheduledBy: admin.id, scheduleTxHash: txOf.get(ops.fromConsole)!,
    });
    // A console record of the same id with another schedule transaction (cancelled, then scheduled again by someone else).
    await db.insert(contractChanges).values({
      chainId: contracts.chainId, timelock: contracts.timelock.toLowerCase(), operationId: ops.readyRole,
      targets: [pc.toLowerCase()], payloads: [grant(ZERO_BYTES32, STRANGER)],
      predecessor: ZERO_BYTES32, salt: hex32(), delaySeconds: 300, summary: [], scheduledBy: admin.id, scheduleTxHash: hex32(),
    });
  });

  afterAll(async () => {
    await db.delete(contractChanges).where(inArray(contractChanges.operationId, allIds));
    await db.execute(sql`delete from chain.timelock_call where op_id in ${allIds}`);
    await db.execute(sql`delete from chain.timelock_operation where id in ${allIds}`);
    await cleanUp();
  });

  it("newest first, each with its phase, decoded calls, worst risk and source", async () => {
    const list = (await loadScheduledChanges(db, contracts, { now }))!.filter((c) => allIds.includes(c.id));
    expect(list.map((c) => [c.id, c.phase, c.risk, c.fromConsole])).toEqual([
      [ops.waitingMoney, "waiting", "money", false],
      [ops.readyRole, "ready", "roles", false],
      [ops.executed, "executed", "money", false],
      [ops.cancelledMoney, "cancelled", "money", false],
      [ops.fromConsole, "waiting", "setting", true],
    ]);
    const first = list[0]!;
    expect(first.calls.map((c) => (c.kind === "setting" ? c.key : c.kind))).toEqual(["feeBps", "emergencyPool"]);
    expect(first.readyAt.getTime()).toBe((nowS + 3600) * 1000);
    expect(list[2]!.executeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(list[3]!.cancelTxHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("the Emergency Pool notice: only waiting or ready changes that move money", async () => {
    const pending = (await pendingMoneyChanges(db, contracts, now)).map((c) => c.id).filter((id) => allIds.includes(id));
    expect(pending).toEqual([ops.waitingMoney]);
  });

  it("pendingOnly leaves out executed and cancelled operations", async () => {
    const pending = (await loadScheduledChanges(db, contracts, { now, pendingOnly: true }))!.map((c) => c.id).filter((id) => allIds.includes(id));
    expect(pending).toEqual([ops.waitingMoney, ops.readyRole, ops.fromConsole]);
  });
});
