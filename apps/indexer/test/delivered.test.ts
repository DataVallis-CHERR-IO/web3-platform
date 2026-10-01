import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { CampaignAbi } from "@cherrio/contracts/abis";
import { deliveredFromLogs, type ReceiptLog } from "../lib/delivered";

const CAMPAIGN: Hex = "0x00000000000000000000000000000000000000c1";
const OTHER_CAMPAIGN: Hex = "0x00000000000000000000000000000000000000c2";
const POOL: Hex = "0x00000000000000000000000000000000000000aa";
const HUMAN: Hex = "0x00000000000000000000000000000000000000d1";

function donated(address: Hex, donor: Hex, amount: bigint, logIndex: number): ReceiptLog {
  return {
    address,
    logIndex,
    topics: encodeEventTopics({ abi: CampaignAbi, eventName: "Donated", args: { donor } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "uint32" }],
      [amount, 0, 0]
    ),
  };
}

function finalized(address: Hex, logIndex: number): ReceiptLog {
  return {
    address,
    logIndex,
    topics: encodeEventTopics({ abi: CampaignAbi, eventName: "Finalized", args: { newState: 1 } }) as Hex[],
    data: "0x",
  };
}

const find = (logs: ReceiptLog[], beforeLogIndex = 10) =>
  deliveredFromLogs({ logs, campaign: CAMPAIGN, pool: POOL, beforeLogIndex, allocationId: 2n });

describe("deliveredFromLogs", () => {
  it("returns the amount of the campaign's Donated log with the pool as donor", () => {
    expect(find([donated(CAMPAIGN, POOL, 600n, 3), finalized(CAMPAIGN, 4)])).toBe(600n);
  });

  it("matches addresses case-insensitively", () => {
    const upper = CAMPAIGN.toUpperCase().replace("0X", "0x") as Hex;
    const logs = [donated(upper, POOL, 5n, 1)];
    const poolUpper = POOL.toUpperCase().replace("0X", "0x") as Hex;
    expect(
      deliveredFromLogs({ logs, campaign: CAMPAIGN, pool: poolUpper, beforeLogIndex: 10, allocationId: 2n })
    ).toBe(5n);
  });

  it("takes the last matching log before the allocation event", () => {
    const logs = [donated(CAMPAIGN, POOL, 100n, 2), donated(CAMPAIGN, POOL, 250n, 6), donated(CAMPAIGN, POOL, 999n, 12)];
    expect(find(logs)).toBe(250n);
    expect(find([...logs].reverse())).toBe(250n);
  });

  it("ignores other emitters, other donors and later logs — and then throws", () => {
    const logs = [
      donated(OTHER_CAMPAIGN, POOL, 400n, 1), // another campaign
      donated(CAMPAIGN, HUMAN, 400n, 2), // a human donor
      finalized(CAMPAIGN, 3), // another Campaign event
      donated(CAMPAIGN, POOL, 400n, 10), // not before the allocation event
    ];
    expect(() => find(logs)).toThrow("Allocation 2 was delivered but its transaction has no Donated log");
  });

  it("throws on an empty receipt instead of assuming an amount", () => {
    expect(() => find([])).toThrow("has no Donated log");
  });
});
