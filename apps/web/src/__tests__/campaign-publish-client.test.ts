import { describe, expect, it } from "vitest";
import {
  decodeFunctionData, encodeFunctionResult, getAddress, zeroAddress, type Address, type EIP1193Provider, type Hex,
} from "viem";
import { CampaignFactoryAbi, PlatformConfigAbi } from "@cherrio/contracts/abis";
import { predictCampaignAddress } from "@cherrio/shared";
import { publishCampaign, PublishCheckError, type PreparedPublishCall } from "@/lib/campaigns/publish-client";

// The browser side of publishing against a fake EIP-1193 provider: every read
// is answered like the real contracts would, and the sent transaction is decoded.

const FACTORY = getAddress("0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00");
const IMPLEMENTATION = getAddress("0x6F6A9F54cC48a13bC5bFc127d16D874D07ccEA8F");
const CONFIG = getAddress("0x4d2570ccB2a6653D62a002027C0d383FfB193A16");
const OPERATOR = getAddress("0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7");
const OPERATOR_ROLE: Hex = `0x${"97".repeat(32)}`;
const OFFCHAIN_ID: Hex = `0x${"ab".repeat(32)}`;
const TX_HASH: Hex = `0x${"cd".repeat(32)}`;

const prepared: PreparedPublishCall = {
  chainId: 80002,
  factory: FACTORY,
  platformConfig: CONFIG,
  predictedAddress: predictCampaignAddress(FACTORY, IMPLEMENTATION, OFFCHAIN_ID),
  params: {
    offchainId: OFFCHAIN_ID,
    beneficiary: getAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"),
    target: "14080800000",
    deadline: "1793448000",
    beneficiaryType: 0,
  },
};

interface World {
  chainId?: number;
  operator?: boolean;
  predicted?: Address;
  existing?: Address;
  previousPending?: boolean;
}

function fakeProvider(world: World = {}) {
  const sent: { from: string; to: string; data: Hex }[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_chainId":
          return `0x${(world.chainId ?? 80002).toString(16)}`;
        case "eth_call": {
          const { to, data } = params![0] as { to: string; data: Hex };
          if (getAddress(to) === CONFIG) {
            const call = decodeFunctionData({ abi: PlatformConfigAbi, data });
            if (call.functionName === "OPERATOR_ROLE")
              return encodeFunctionResult({ abi: PlatformConfigAbi, functionName: "OPERATOR_ROLE", result: OPERATOR_ROLE });
            if (call.functionName === "hasRole") {
              const [role, account] = call.args as [Hex, Address];
              const has = (world.operator ?? true) && role === OPERATOR_ROLE && getAddress(account) === OPERATOR;
              return encodeFunctionResult({ abi: PlatformConfigAbi, functionName: "hasRole", result: has });
            }
          }
          if (getAddress(to) === FACTORY) {
            const call = decodeFunctionData({ abi: CampaignFactoryAbi, data });
            if (call.functionName === "predictCampaignAddress")
              return encodeFunctionResult({
                abi: CampaignFactoryAbi, functionName: "predictCampaignAddress",
                result: world.predicted ?? predictCampaignAddress(FACTORY, IMPLEMENTATION, call.args[0] as Hex),
              });
            if (call.functionName === "campaigns")
              return encodeFunctionResult({ abi: CampaignFactoryAbi, functionName: "campaigns", result: world.existing ?? zeroAddress });
          }
          throw new Error(`unexpected eth_call to ${to}`);
        }
        case "eth_getTransactionByHash":
          return world.previousPending
            ? { hash: params![0], blockNumber: null, blockHash: null, transactionIndex: null, from: OPERATOR, to: FACTORY,
                input: "0x", value: "0x0", gas: "0x1", nonce: "0x1", type: "0x2", maxFeePerGas: "0x1",
                maxPriorityFeePerGas: "0x1", chainId: "0x13882", v: "0x0", r: "0x1", s: "0x1", accessList: [] }
            : null;
        case "eth_sendTransaction":
          sent.push(params![0] as { from: string; to: string; data: Hex });
          return TX_HASH;
        default:
          throw new Error(`unexpected RPC method ${method}`);
      }
    },
  } as unknown as EIP1193Provider;
  return { provider, sent };
}

describe("publishCampaign (browser side, fake wallet provider)", () => {
  it("sends createCampaign to the factory from the operator with exactly the prepared parameters", async () => {
    const { provider, sent } = fakeProvider();
    expect(await publishCampaign(provider, OPERATOR, prepared, null)).toEqual({ kind: "sent", txHash: TX_HASH });
    expect(sent).toHaveLength(1);
    expect(getAddress(sent[0]!.to)).toBe(FACTORY);
    expect(getAddress(sent[0]!.from)).toBe(OPERATOR);
    const call = decodeFunctionData({ abi: CampaignFactoryAbi, data: sent[0]!.data });
    expect(call.functionName).toBe("createCampaign");
    expect(call.args).toEqual([
      { offchainId: OFFCHAIN_ID, beneficiary: prepared.params.beneficiary, target: 14_080_800_000n, deadline: 1_793_448_000n, beneficiaryType: 0 },
    ]);
  });

  it("refuses before signing: wrong chain, no operator role, a different predicted address, a pending earlier transaction", async () => {
    const cases: [World, string][] = [
      [{ chainId: 137 }, "wrong_chain"],
      [{ operator: false }, "not_operator"],
      [{ predicted: getAddress(`0x${"12".repeat(20)}`) }, "prediction_mismatch"],
    ];
    for (const [world, code] of cases) {
      const { provider, sent } = fakeProvider(world);
      await expect(publishCampaign(provider, OPERATOR, prepared, null)).rejects.toEqual(new PublishCheckError(code as never));
      expect(sent, code).toEqual([]);
    }
    const pending = fakeProvider({ previousPending: true });
    await expect(publishCampaign(pending.provider, OPERATOR, prepared, `0x${"ef".repeat(32)}`)).rejects.toThrow("previous_pending");
    expect(pending.sent).toEqual([]);
  });

  it("does not send when the factory already has a campaign for the offchain id (only links)", async () => {
    const onChain = prepared.predictedAddress;
    const { provider, sent } = fakeProvider({ existing: onChain });
    expect(await publishCampaign(provider, OPERATOR, prepared, `0x${"ef".repeat(32)}`)).toEqual({ kind: "already_on_chain", address: onChain });
    expect(sent).toEqual([]);
  });

  it("an earlier transaction that is unknown (dropped) or mined does not block a new one", async () => {
    const { provider, sent } = fakeProvider({ previousPending: false });
    expect((await publishCampaign(provider, OPERATOR, prepared, `0x${"ef".repeat(32)}`)).kind).toBe("sent");
    expect(sent).toHaveLength(1);
  });
});
