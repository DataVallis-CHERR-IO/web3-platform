import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { PlatformConfigAbi } from "@cherrio/contracts/abis";
import {
  CONFIG_PARAMS, checkRaw, decodeSetter, durationInput, durationParts, encodeSetter, formatPercent, humanInput,
  paramSpec, parseDuration, parseHuman, parsePercent,
} from "@/lib/contracts/config-params";
import { executeBatchData, operationId, randomSalt, safeTransactionBuilderJson, scheduleBatchData, ZERO_BYTES32 } from "@/lib/contracts/timelock";

// TASK-034a: PlatformConfig values in human units, exact both ways, with the
// contract's own bounds; timelock operation ids identical to OpenZeppelin's.

const CONFIG: Address = "0x4d2570ccB2a6653D62a002027C0d383FfB193A16";
const TIMELOCK: Address = "0x52ba2090E62c9155c04E7E5f28DB9Af00A6AAede";
const DAY = 86_400n;

describe("percent ↔ basis points", () => {
  it.each([
    ["25", 2500n], ["25.5", 2550n], ["0.01", 1n], ["50,01", 5001n], ["100", 10_000n], ["1 %", 100n], ["0", 0n],
  ])("parses %s", (input, bps) => {
    expect(parsePercent(input)).toEqual({ ok: true, bps });
  });

  it.each(["", "abc", "-1", "1e2", "25.", ".5", "1.2.3"])("rejects %j", (input) => {
    expect(parsePercent(input)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects more than two decimals instead of rounding", () => {
    expect(parsePercent("25.555")).toEqual({ ok: false, reason: "too_precise" });
  });

  it.each([[2500n, "25"], [2550n, "25.5"], [1n, "0.01"], [5100n, "51"], [10n, "0.1"]])("formats %s", (bps, text) => {
    expect(formatPercent(bps)).toBe(text);
  });
});

describe("durations", () => {
  it("converts whole units to seconds", () => {
    expect(parseDuration("7", "days")).toEqual({ ok: true, seconds: 7n * DAY });
    expect(parseDuration("1", "hours")).toEqual({ ok: true, seconds: 3600n });
    expect(parseDuration("90", "minutes")).toEqual({ ok: true, seconds: 5400n });
  });

  it.each(["1.5", "", "-1", "1h"])("rejects %j", (input) => {
    expect(parseDuration(input, "hours")).toEqual({ ok: false, reason: "invalid" });
  });

  it("splits seconds into parts for wording", () => {
    expect(durationParts(108_000n)).toEqual({ days: 1, hours: 6, minutes: 0, seconds: 0 });
    expect(durationParts(604_800n)).toEqual({ days: 7, hours: 0, minutes: 0, seconds: 0 });
  });

  it("prefills the largest exact unit", () => {
    expect(durationInput(604_800n)).toEqual({ amount: "7", unit: "days" });
    expect(durationInput(3_600n)).toEqual({ amount: "1", unit: "hours" });
    expect(durationInput(5_400n)).toEqual({ amount: "90", unit: "minutes" });
    expect(durationInput(0n)).toEqual({ amount: "0", unit: "days" });
  });
});

describe("bounds — the contract's own limits", () => {
  it.each([
    ["voteWindow", "59", "minutes", "below_min"],
    ["voteWindow", "1", "hours", null],
    ["voteWindow", "14", "days", null],
    ["voteWindow", "15", "days", "above_max"],
    ["releaseDelay", "0", "days", null],
    ["releaseDelay", "8", "days", "above_max"],
    ["refundSweepDelay", "29", "days", "below_min"],
    ["refundSweepDelay", "366", "days", "above_max"],
  ] as const)("%s %s %s → %s", (key, amount, unit, reason) => {
    const r = parseHuman(paramSpec(key), amount, unit);
    expect(r.ok ? null : r.reason).toBe(reason);
  });

  it.each([
    ["feeBps", "5", null], ["feeBps", "5.01", "above_max"], ["feeBps", "0", null],
    ["approvalBps", "50", "below_min"], ["approvalBps", "50.01", null],
    ["quorumBps", "0", "below_min"], ["quorumBps", "25", null], ["quorumBps", "100.01", "above_max"],
    ["successThresholdBps", "10", null],
  ] as const)("%s %s%% → %s", (key, input, reason) => {
    const r = parseHuman(paramSpec(key), input);
    expect(r.ok ? null : r.reason).toBe(reason);
  });

  it("minimum donation in USDC with six decimals, never zero", () => {
    expect(parseHuman(paramSpec("minDonation"), "1")).toEqual({ ok: true, value: 1_000_000n });
    expect(parseHuman(paramSpec("minDonation"), "0.000001")).toEqual({ ok: true, value: 1n });
    expect(parseHuman(paramSpec("minDonation"), "0")).toEqual({ ok: false, reason: "below_min" });
    expect(parseHuman(paramSpec("minDonation"), "0.0000001")).toEqual({ ok: false, reason: "too_precise" });
  });

  it("addresses must be valid and non-zero", () => {
    expect(parseHuman(paramSpec("treasury"), "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toEqual({
      ok: true, value: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    });
    expect(parseHuman(paramSpec("treasury"), `0x${"0".repeat(40)}`)).toEqual({ ok: false, reason: "zero_address" });
    expect(parseHuman(paramSpec("treasury"), "0x123")).toEqual({ ok: false, reason: "invalid" });
  });

  it("humanInput is the inverse of parseHuman for every parameter", () => {
    const samples: Record<string, bigint | Address> = {
      feeBps: 100n, successThresholdBps: 1000n, voteWindow: 604_800n, quorumBps: 2500n, approvalBps: 5100n,
      refundSweepDelay: 180n * DAY, minDonation: 1_500_000n, releaseDelay: 259_200n,
      treasury: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", emergencyPool: CONFIG,
    };
    for (const spec of CONFIG_PARAMS) {
      const shown = humanInput(spec, samples[spec.key]!);
      expect(parseHuman(spec, shown.amount, shown.unit)).toEqual({ ok: true, value: samples[spec.key] });
    }
  });
});

describe("setter payloads", () => {
  it("encodes exactly what the ABI encodes", () => {
    expect(encodeSetter(paramSpec("voteWindow"), 3600n)).toBe(
      "0x9e33a38e0000000000000000000000000000000000000000000000000000000000000e10" // cast calldata "setVoteWindow(uint32)" 3600
    );
    expect(encodeSetter(paramSpec("quorumBps"), 2500n)).toBe(
      "0x0527aab600000000000000000000000000000000000000000000000000000000000009c4" // cast calldata "setQuorumBps(uint16)" 2500
    );
  });

  it("refuses to encode an out-of-bounds value", () => {
    expect(() => encodeSetter(paramSpec("voteWindow"), 60n)).toThrow("below_min");
  });

  it("decodes known setters back to the parameter and value", () => {
    for (const spec of CONFIG_PARAMS) {
      const value = spec.kind === "address" ? TIMELOCK : spec.min === 0n ? 1n : spec.min;
      expect(decodeSetter(encodeSetter(spec, value))).toEqual({ spec, value });
    }
  });

  it("rejects anything that is not an in-bounds config setter", () => {
    const grant = encodeFunctionData({
      abi: PlatformConfigAbi, functionName: "grantRole", args: [ZERO_BYTES32, TIMELOCK],
    });
    expect(decodeSetter(grant)).toBeNull();
    // setVoteWindow(60) is a valid ABI call but outside the contract's bounds.
    expect(decodeSetter(encodeFunctionData({ abi: PlatformConfigAbi, functionName: "setVoteWindow", args: [60] }))).toBeNull();
    // Trailing bytes after a valid call.
    expect(decodeSetter(`${encodeSetter(paramSpec("quorumBps"), 2500n)}00` as Hex)).toBeNull();
    expect(decodeSetter("0x")).toBeNull();
  });

  it("checkRaw rejects a wrong value type", () => {
    expect(checkRaw(paramSpec("quorumBps"), TIMELOCK)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("timelock operations", () => {
  const op = {
    targets: [CONFIG, CONFIG],
    payloads: [encodeSetter(paramSpec("voteWindow"), 3600n), encodeSetter(paramSpec("quorumBps"), 2500n)],
    predecessor: ZERO_BYTES32,
    salt: `0x${"0".repeat(63)}1` as Hex,
  };

  it("operation id equals OpenZeppelin hashOperationBatch (reference computed with cast)", () => {
    // cast keccak $(cast abi-encode "f(address[],uint256[],bytes[],bytes32,bytes32)" [cfg,cfg] [0,0] [p1,p2] 0x00…00 0x00…01)
    expect(operationId(op)).toBe("0xd0b56c47a8b956870d84278ad2aa9e73f972a6459cd12ccc6201f4ab412e9e5d");
  });

  it("a different salt gives a different id", () => {
    expect(operationId({ ...op, salt: randomSalt() })).not.toBe(operationId(op));
    expect(randomSalt()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("builds scheduleBatch / executeBatch calldata and a Safe Transaction Builder file", () => {
    expect(scheduleBatchData(op, 300n).slice(0, 10)).toBe("0x8f2a0bb0"); // scheduleBatch selector
    expect(executeBatchData(op).slice(0, 10)).toBe("0xe38335e5"); // executeBatch selector
    const json = JSON.parse(safeTransactionBuilderJson(137, TIMELOCK, scheduleBatchData(op, 172_800n), "Vote window")) as {
      chainId: string; transactions: { to: string; value: string; data: string }[];
    };
    expect(json.chainId).toBe("137");
    expect(json.transactions).toEqual([{ to: TIMELOCK, value: "0", data: scheduleBatchData(op, 172_800n) }]);
  });
});
