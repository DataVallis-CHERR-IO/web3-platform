import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, erc20Abi, type Hash } from "viem";
import { describe, expect, it } from "vitest";
import { AGENT_CREW } from "@cherrio/shared/agent-crew";
import type { Chain } from "../src/chain.js";
import type { CrewMember } from "../src/crew.js";
import { RETURN_MIN_USDC, returnFunds, returnPlan } from "../src/return-funds.js";
import type { TxRequest } from "../src/policy.js";

// TASK-061g part B: no network, no key. The chain is a fake EIP-1193 provider.

const crew = AGENT_CREW.map((c) => ({ index: c.index, name: c.name, persona: c.persona, address: c.address, account: {} as never })) as CrewMember[];
const by = (name: string) => crew.find((m) => m.name === name)!;
const USDC = "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582" as const;
const HASH = `0x${"ab".repeat(32)}` as Hash;

function setup(balance: bigint, receiptStatus: "0x1" | "0x0" = "0x1") {
  const provider = {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_call") return encodeAbiParameters([{ type: "uint256" }], [balance]);
      if (method === "eth_chainId") return "0x13882";
      if (method === "eth_getTransactionReceipt") {
        return { status: receiptStatus, transactionHash: HASH, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1", transactionIndex: "0x0",
          from: USDC, to: USDC, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2", contractAddress: null };
      }
      if (method === "eth_blockNumber") return "0x1";
      throw new Error(`unexpected ${method}`);
    },
  };
  const client = createPublicClient({ transport: custom(provider, { retryCount: 0 }) });
  const chain = {
    client, usdc: USDC, factory: "0x00000000000000000000000000000000000000f1", pool: "0x00000000000000000000000000000000000000f2",
    isCampaign: async () => false, rpc: async () => null,
  } as unknown as Chain;
  const sent: TxRequest[] = [];
  const steps: { step: string; ok: boolean; detail: string; hashes?: string[] }[] = [];
  const record = (step: string, ok: boolean, detail: string, extra?: { txHashes?: string[] }) => steps.push({ step, ok, detail, hashes: extra?.txHashes });
  const o = { rpcUrl: "http://fake", pollingInterval: 5, send: async (tx: TxRequest) => { sent.push(tx); return HASH; } };
  return { chain, sent, steps, record, o };
}

describe("returnPlan", () => {
  it("is the whole balance at or above the threshold, only for fundraisers", () => {
    expect(RETURN_MIN_USDC).toBe(5_000_000n);
    expect(returnPlan(by("fundraiser-1"), 4_999_999n)).toBe(0n);
    expect(returnPlan(by("fundraiser-1"), 5_000_000n)).toBe(5_000_000n);
    expect(returnPlan(by("fundraiser-1"), 12_345_678n)).toBe(12_345_678n);
    expect(returnPlan(by("donor-1"), 99_000_000n)).toBe(0n);
    expect(returnPlan(by("treasury"), 99_000_000n)).toBe(0n);
  });
});

describe("returnFunds", () => {
  it("below the threshold sends nothing", async () => {
    const s = setup(4_999_999n);
    expect(await returnFunds(s.chain, crew, by("fundraiser-1"), s.record, s.o)).toBe("skipped");
    expect(s.sent).toHaveLength(0);
    expect(s.steps[0]).toMatchObject({ ok: true });
    expect(s.steps[0]!.detail).toContain("skipped");
  });

  it("above it sends one transfer of the full balance to the treasury and records the hash", async () => {
    const s = setup(12_345_678n);
    expect(await returnFunds(s.chain, crew, by("fundraiser-2"), s.record, s.o)).toBe("returned");
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.to).toBe(USDC);
    const call = decodeFunctionData({ abi: erc20Abi, data: s.sent[0]!.data as `0x${string}` });
    expect(call.functionName).toBe("transfer");
    expect((call.args as [string, bigint])[0].toLowerCase()).toBe(by("treasury").address);
    expect((call.args as [string, bigint])[1]).toBe(12_345_678n);
    expect(s.steps).toEqual([{ step: "return funds", ok: true, detail: expect.stringContaining("12.345678 USDC"), hashes: [HASH] }]);
  });

  it("never for the treasury or a non-fundraiser", async () => {
    for (const name of ["treasury", "donor-1", "staff", "scammer-1"]) {
      const s = setup(50_000_000n);
      expect(await returnFunds(s.chain, crew, by(name), s.record, s.o), name).toBe("skipped");
      expect(s.sent, name).toHaveLength(0);
    }
  });

  it("a policy refusal is a failed step and nothing is sent", async () => {
    const s = setup(50_000_000n);
    // A destination outside the crew: "USDC may be transferred to crew members only".
    const o = { ...s.o, treasuryAddress: "0x00000000000000000000000000000000000000aa" as `0x${string}` };
    expect(await returnFunds(s.chain, crew, by("fundraiser-1"), s.record, o)).toBe("failed");
    expect(s.sent).toHaveLength(0);
    expect(s.steps[0]).toMatchObject({ step: "return funds", ok: false });
    expect(s.steps[0]!.detail).toContain("policy refused");
  });

  it("a reverted transfer and a send error are failed steps", async () => {
    const reverted = setup(50_000_000n, "0x0");
    expect(await returnFunds(reverted.chain, crew, by("fundraiser-1"), reverted.record, reverted.o)).toBe("failed");
    expect(reverted.steps[0]).toMatchObject({ ok: false, hashes: [HASH] });
    const broken = setup(50_000_000n);
    broken.o.send = async () => { throw new Error("insufficient funds for gas"); };
    expect(await returnFunds(broken.chain, crew, by("fundraiser-1"), broken.record, broken.o)).toBe("failed");
    expect(broken.steps[0]!.detail).toContain("insufficient funds");
  });
});
