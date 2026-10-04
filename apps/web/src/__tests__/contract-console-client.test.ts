import { describe, expect, it } from "vitest";
import {
  createPublicClient, custom, decodeFunctionData, encodeFunctionResult, getAddress, keccak256, toHex, UserRejectedRequestError, zeroAddress,
  type Address, type EIP1193Provider, type Hex,
} from "viem";
import { PlatformConfigAbi } from "@cherrio/contracts/abis";
import {
  buildOperation, cancelChange, ConsoleError, executeChange, readOperation, readRoles, readSnapshot, scheduleChange,
  toConsoleFailure, type ConsoleChain,
} from "@/lib/contracts/console-client";
import { encodeSetter, paramSpec } from "@/lib/contracts/config-params";
import { operationId, TimelockAbi } from "@/lib/contracts/timelock";

// TASK-034b: the browser side of the contract console against a fake EIP-1193
// provider that answers like PlatformConfig and the OZ TimelockController.

const CHAIN: ConsoleChain = {
  chainId: 80002,
  timelock: getAddress("0x52ba2090E62c9155c04E7E5f28DB9Af00A6AAede"),
  platformConfig: getAddress("0x4d2570ccB2a6653D62a002027C0d383FfB193A16"),
};
const ADMIN = getAddress("0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7");
const STRANGER = getAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
const TREASURY = getAddress("0x1111111111111111111111111111111111111111");
const POOL = getAddress("0xFa7Fd0253813E196d74575A8F93ABB91cd009517");
const ROLE = (name: string) => keccak256(toHex(name));

interface World {
  chainId?: number;
  holders?: Record<string, Address[]>;
  opState?: number;
  rejectSend?: boolean;
}

function fake(world: World = {}) {
  const holders = world.holders ?? {
    PROPOSER_ROLE: [ADMIN], EXECUTOR_ROLE: [ADMIN], CANCELLER_ROLE: [ADMIN], OPERATOR_ROLE: [ADMIN], GUARDIAN_ROLE: [ADMIN],
  };
  const sent: { to: Address; fn: string; args: readonly unknown[] }[] = [];
  const values: Record<string, unknown> = {
    feeBps: 100, successThresholdBps: 1000, voteWindow: 86_400, quorumBps: 5000, approvalBps: 5100,
    refundSweepDelay: 15_552_000, minDonation: 1_000_000n, releaseDelay: 259_200, treasury: TREASURY, emergencyPool: POOL,
  };
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_chainId":
          return `0x${(world.chainId ?? 80002).toString(16)}`;
        case "eth_call": {
          const { to, data } = params![0] as { to: string; data: Hex };
          if (getAddress(to) === CHAIN.platformConfig) {
            const call = decodeFunctionData({ abi: PlatformConfigAbi, data });
            const fn = call.functionName as string;
            if (fn === "OPERATOR_ROLE" || fn === "GUARDIAN_ROLE")
              return encodeFunctionResult({ abi: PlatformConfigAbi, functionName: fn, result: ROLE(fn) });
            if (fn === "hasRole") {
              const [role, who] = call.args as [Hex, Address];
              const name = Object.keys(holders).find((n) => ROLE(n) === role)!;
              return encodeFunctionResult({ abi: PlatformConfigAbi, functionName: "hasRole", result: (holders[name] ?? []).includes(getAddress(who)) });
            }
            return encodeFunctionResult({ abi: PlatformConfigAbi, functionName: fn as never, result: values[fn] as never });
          }
          if (getAddress(to) === CHAIN.timelock) {
            const call = decodeFunctionData({ abi: TimelockAbi, data });
            switch (call.functionName) {
              case "PROPOSER_ROLE": case "EXECUTOR_ROLE": case "CANCELLER_ROLE":
                return encodeFunctionResult({ abi: TimelockAbi, functionName: call.functionName, result: ROLE(call.functionName) });
              case "hasRole": {
                const [role, who] = call.args as [Hex, Address];
                const name = Object.keys(holders).find((n) => ROLE(n) === role)!;
                return encodeFunctionResult({ abi: TimelockAbi, functionName: "hasRole", result: (holders[name] ?? []).includes(getAddress(who)) });
              }
              case "getMinDelay": return encodeFunctionResult({ abi: TimelockAbi, functionName: "getMinDelay", result: 300n });
              case "getOperationState":
                return encodeFunctionResult({ abi: TimelockAbi, functionName: "getOperationState", result: world.opState ?? 2 });
              case "getTimestamp": return encodeFunctionResult({ abi: TimelockAbi, functionName: "getTimestamp", result: 1_791_100_000n });
            }
          }
          throw new Error(`unexpected eth_call to ${to}`);
        }
        case "eth_getBlockByNumber":
          return { number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: "0x6a0f0000",
                   baseFeePerGas: "0x" + (40n * 10n ** 9n).toString(16), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [],
                   uncles: [], nonce: "0x0000000000000000", difficulty: "0x0", logsBloom: "0x" + "00".repeat(256), miner: zeroAddress,
                   extraData: "0x", size: "0x1", stateRoot: `0x${"33".repeat(32)}`, receiptsRoot: `0x${"44".repeat(32)}`,
                   transactionsRoot: `0x${"55".repeat(32)}`, sha3Uncles: `0x${"66".repeat(32)}`, mixHash: `0x${"77".repeat(32)}` };
        case "eth_maxPriorityFeePerGas":
          return "0x" + 1_500_000_000n.toString(16);
        case "eth_sendTransaction": {
          if (world.rejectSend) throw new UserRejectedRequestError(new Error("User rejected the request."));
          const tx = params![0] as { to: Address; data: Hex };
          const call = decodeFunctionData({ abi: TimelockAbi, data: tx.data });
          sent.push({ to: getAddress(tx.to), fn: call.functionName, args: call.args ?? [] });
          return `0x${"cd".repeat(32)}`;
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  } as unknown as EIP1193Provider;
  return { provider, sent };
}

const reader = (provider: EIP1193Provider) => createPublicClient({ transport: custom(provider) });

describe("reading", () => {
  it("reads every config value with its type and the timelock delay", async () => {
    const { provider } = fake();
    const snap = await readSnapshot(reader(provider), CHAIN);
    expect(snap.minDelay).toBe(300n);
    expect(snap.values).toEqual({
      feeBps: 100n, successThresholdBps: 1000n, voteWindow: 86_400n, quorumBps: 5000n, approvalBps: 5100n,
      refundSweepDelay: 15_552_000n, minDonation: 1_000_000n, releaseDelay: 259_200n, treasury: TREASURY, emergencyPool: POOL,
    });
  });

  it("reads the roles of a wallet, including an open executor role", async () => {
    expect(await readRoles(reader(fake().provider), CHAIN, ADMIN)).toEqual({
      proposer: true, executor: true, canceller: true, operator: true, guardian: true,
    });
    expect(await readRoles(reader(fake().provider), CHAIN, STRANGER)).toEqual({
      proposer: false, executor: false, canceller: false, operator: false, guardian: false,
    });
    const open = fake({ holders: { EXECUTOR_ROLE: [zeroAddress] } });
    expect((await readRoles(reader(open.provider), CHAIN, STRANGER)).executor).toBe(true);
  });

  it("maps the operation state", async () => {
    expect(await readOperation(reader(fake({ opState: 1 }).provider), CHAIN.timelock, `0x${"aa".repeat(32)}`)).toEqual({
      state: "waiting", readyAt: 1_791_100_000n,
    });
  });
});

describe("writing", () => {
  const changes = { voteWindow: 3600n, quorumBps: 2500n };
  const salt: Hex = `0x${"0".repeat(63)}1`;

  it("builds one batch in parameter order", () => {
    const op = buildOperation(CHAIN, { quorumBps: 2500n, voteWindow: 3600n }, salt);
    expect(op.payloads).toEqual([encodeSetter(paramSpec("voteWindow"), 3600n), encodeSetter(paramSpec("quorumBps"), 2500n)]);
    expect(op.targets).toEqual([CHAIN.platformConfig, CHAIN.platformConfig]);
    expect(() => buildOperation(CHAIN, {})).toThrow("no changes");
  });

  it("schedules through the timelock with its minimum delay — never a setter directly", async () => {
    const { provider, sent } = fake();
    const op = buildOperation(CHAIN, changes, salt);
    await scheduleChange(provider, ADMIN, CHAIN, op, 300n);
    expect(sent).toEqual([
      { to: CHAIN.timelock, fn: "scheduleBatch", args: [op.targets, [0n, 0n], op.payloads, op.predecessor, salt, 300n] },
    ]);
  });

  it("refuses a wallet without the proposer role, or on the wrong network, before sending", async () => {
    const op = buildOperation(CHAIN, changes, salt);
    const a = fake();
    await expect(scheduleChange(a.provider, STRANGER, CHAIN, op, 300n)).rejects.toMatchObject({ code: "not_proposer" });
    const b = fake({ chainId: 137 });
    await expect(scheduleChange(b.provider, ADMIN, CHAIN, op, 300n)).rejects.toMatchObject({ code: "wrong_network" });
    expect([...a.sent, ...b.sent]).toEqual([]);
  });

  it("executes only a ready operation, with the same arguments", async () => {
    const op = buildOperation(CHAIN, changes, salt);
    const id = operationId(op);
    const waiting = fake({ opState: 1 });
    await expect(executeChange(waiting.provider, ADMIN, CHAIN, op, id)).rejects.toMatchObject({ code: "not_ready" });
    expect(waiting.sent).toEqual([]);
    const ready = fake({ opState: 2 });
    await executeChange(ready.provider, ADMIN, CHAIN, op, id);
    expect(ready.sent).toEqual([{ to: CHAIN.timelock, fn: "executeBatch", args: [op.targets, [0n, 0n], op.payloads, op.predecessor, salt] }]);
  });

  it("cancels with the canceller role only", async () => {
    const id: Hex = `0x${"ab".repeat(32)}`;
    const { provider, sent } = fake();
    await cancelChange(provider, ADMIN, CHAIN, id);
    expect(sent).toEqual([{ to: CHAIN.timelock, fn: "cancel", args: [id] }]);
    await expect(cancelChange(fake().provider, STRANGER, CHAIN, id)).rejects.toMatchObject({ code: "not_canceller" });
  });

  it("maps a rejection in the wallet", async () => {
    const op = buildOperation(CHAIN, changes, salt);
    const error = await scheduleChange(fake({ rejectSend: true }).provider, ADMIN, CHAIN, op, 300n).catch((e: unknown) => e);
    expect(toConsoleFailure(error)).toBe("rejected");
    expect(toConsoleFailure(new ConsoleError("not_ready"))).toBe("not_ready");
    expect(toConsoleFailure(new Error("insufficient funds for gas"))).toBe("insufficient_gas");
  });
});
