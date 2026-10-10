import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";
import { PlatformConfigAbi } from "@cherrio/contracts/abis";
import { parseUsdc, USDC_UNIT } from "@cherrio/shared/money";

// PlatformConfig parameters in human units (TASK-034, ADR-046).
// Every conversion is exact (bigint, no floats). Bounds mirror the contract's own
// checks (PlatformConfig.sol setters); the contract checks again on execution.
// Pure: shared by the admin console (browser) and the record API (server).

export type ConfigKey =
  | "feeBps"
  | "successThresholdBps"
  | "voteWindow"
  | "quorumBps"
  | "approvalBps"
  | "refundSweepDelay"
  | "minDonation"
  | "releaseDelay"
  | "treasury"
  | "emergencyPool";

export type ParamKind = "percent" | "duration" | "usdc" | "address";

export interface ParamSpec {
  key: ConfigKey;
  setter:
    | "setFeeBps"
    | "setSuccessThresholdBps"
    | "setVoteWindow"
    | "setQuorumBps"
    | "setApprovalBps"
    | "setRefundSweepDelay"
    | "setMinDonation"
    | "setReleaseDelay"
    | "setTreasury"
    | "setEmergencyPool";
  kind: ParamKind;
  /** Inclusive bounds in raw units (bps, seconds, USDC units). Not used for addresses. */
  min: bigint;
  max: bigint;
}

const HOUR = 3_600n;
const DAY = 86_400n;

export const CONFIG_PARAMS: readonly ParamSpec[] = [
  { key: "feeBps", setter: "setFeeBps", kind: "percent", min: 0n, max: 500n },
  { key: "successThresholdBps", setter: "setSuccessThresholdBps", kind: "percent", min: 1n, max: 10_000n },
  { key: "voteWindow", setter: "setVoteWindow", kind: "duration", min: HOUR, max: 14n * DAY },
  { key: "quorumBps", setter: "setQuorumBps", kind: "percent", min: 1n, max: 10_000n },
  { key: "approvalBps", setter: "setApprovalBps", kind: "percent", min: 5_001n, max: 10_000n },
  { key: "refundSweepDelay", setter: "setRefundSweepDelay", kind: "duration", min: 30n * DAY, max: 365n * DAY },
  { key: "minDonation", setter: "setMinDonation", kind: "usdc", min: 1n, max: 1_000_000_000n }, // PlatformConfig.MAX_MIN_DONATION (ADR-061)
  { key: "releaseDelay", setter: "setReleaseDelay", kind: "duration", min: 0n, max: 7n * DAY },
  { key: "treasury", setter: "setTreasury", kind: "address", min: 0n, max: 0n },
  { key: "emergencyPool", setter: "setEmergencyPool", kind: "address", min: 0n, max: 0n },
];

export function paramSpec(key: ConfigKey): ParamSpec {
  const spec = CONFIG_PARAMS.find((p) => p.key === key);
  if (!spec) throw new Error(`Unknown config parameter ${key}`);
  return spec;
}

/** A raw on-chain value: bigint for numbers, a checksummed address for addresses. */
export type RawValue = bigint | Address;

export type ParseResult = { ok: true; value: RawValue } | { ok: false; reason: ParseFailure };
export type ParseFailure = "invalid" | "too_precise" | "below_min" | "above_max" | "zero_address";

// ── Percent ↔ basis points ───────────────────────────────────────────────────

/** "25" → 2500n, "0.01" → 1n, "50,01" → 5001n. At most two decimals. */
export function parsePercent(input: string): { ok: true; bps: bigint } | { ok: false; reason: "invalid" | "too_precise" } {
  const s = input.trim().replace(",", ".").replace(/\s*%$/, "");
  const m = /^(\d{1,5})(?:\.(\d+))?$/.exec(s);
  if (!m) return { ok: false, reason: "invalid" };
  const fraction = m[2] ?? "";
  if (fraction.length > 2) return { ok: false, reason: "too_precise" };
  return { ok: true, bps: BigInt(m[1]!) * 100n + BigInt(fraction.padEnd(2, "0")) };
}

/** 2550n → "25.5", 2500n → "25", 1n → "0.01" (the unit is added by the UI). */
export function formatPercent(bps: bigint): string {
  const whole = bps / 100n;
  const fraction = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

// ── Durations ────────────────────────────────────────────────────────────────

export type DurationUnit = "minutes" | "hours" | "days";
const UNIT_SECONDS: Record<DurationUnit, bigint> = { minutes: 60n, hours: HOUR, days: DAY };

/** Whole numbers only: ("7", "days") → 604800n. */
export function parseDuration(amount: string, unit: DurationUnit): { ok: true; seconds: bigint } | { ok: false; reason: "invalid" } {
  const s = amount.trim();
  if (!/^\d{1,7}$/.test(s)) return { ok: false, reason: "invalid" };
  return { ok: true, seconds: BigInt(s) * UNIT_SECONDS[unit] };
}

export interface DurationParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** 108000n → { days: 1, hours: 6, minutes: 0, seconds: 0 }; the UI words it. */
export function durationParts(total: bigint): DurationParts {
  return {
    days: Number(total / DAY),
    hours: Number((total % DAY) / HOUR),
    minutes: Number((total % HOUR) / 60n),
    seconds: Number(total % 60n),
  };
}

/** The largest unit that represents `seconds` exactly — to prefill the form. */
export function durationInput(seconds: bigint): { amount: string; unit: DurationUnit } {
  for (const unit of ["days", "hours", "minutes"] as const) {
    if (seconds % UNIT_SECONDS[unit] === 0n) return { amount: (seconds / UNIT_SECONDS[unit]).toString(), unit };
  }
  // Not a whole minute: shown in whole minutes, the remainder dropped (only reachable for odd on-chain values).
  return { amount: (seconds / 60n).toString(), unit: "minutes" };
}

// ── Checking a value against a parameter ────────────────────────────────────

/** Bounds check of a raw value (the contract's own limits). */
export function checkRaw(spec: ParamSpec, value: RawValue): ParseResult {
  if (spec.kind === "address") {
    if (typeof value !== "string" || !isAddress(value, { strict: false })) return { ok: false, reason: "invalid" };
    if (BigInt(value) === 0n) return { ok: false, reason: "zero_address" };
    return { ok: true, value: getAddress(value) };
  }
  if (typeof value !== "bigint") return { ok: false, reason: "invalid" };
  if (value < spec.min) return { ok: false, reason: "below_min" };
  if (value > spec.max) return { ok: false, reason: "above_max" };
  return { ok: true, value };
}

/** Human input → raw value, with the bounds check. `unit` is used for durations only. */
export function parseHuman(spec: ParamSpec, input: string, unit: DurationUnit = "days"): ParseResult {
  switch (spec.kind) {
    case "percent": {
      const r = parsePercent(input);
      return r.ok ? checkRaw(spec, r.bps) : r;
    }
    case "duration": {
      const r = parseDuration(input, unit);
      return r.ok ? checkRaw(spec, r.seconds) : r;
    }
    case "usdc": {
      try {
        return checkRaw(spec, parseUsdc(input.trim().replace(",", ".")));
      } catch (e) {
        return { ok: false, reason: e instanceof Error && e.message.includes("precision") ? "too_precise" : "invalid" };
      }
    }
    case "address":
      return checkRaw(spec, input.trim() as Address);
  }
}

/** Raw value → what the form field shows. */
export function humanInput(spec: ParamSpec, value: RawValue): { amount: string; unit?: DurationUnit } {
  if (spec.kind === "address") return { amount: String(value) };
  const v = value as bigint;
  if (spec.kind === "percent") return { amount: formatPercent(v) };
  if (spec.kind === "duration") return durationInput(v);
  const whole = v / USDC_UNIT;
  const fraction = (v % USDC_UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return { amount: fraction ? `${whole}.${fraction}` : whole.toString() };
}

/** The raw value as a string (JSON, DB): decimal for numbers, checksummed for addresses. */
export function rawToString(value: RawValue): string {
  return typeof value === "bigint" ? value.toString() : getAddress(value);
}

// ── Encoding setter calls ────────────────────────────────────────────────────

/** ABI-encoded setter call for the timelock payload. */
export function encodeSetter(spec: ParamSpec, value: RawValue): Hex {
  const checked = checkRaw(spec, value);
  if (!checked.ok) throw new Error(`${spec.key}: ${checked.reason}`);
  const v = checked.value;
  switch (spec.setter) {
    case "setTreasury":
    case "setEmergencyPool":
      return encodeFunctionData({ abi: PlatformConfigAbi, functionName: spec.setter, args: [v as Address] });
    case "setFeeBps":
    case "setSuccessThresholdBps":
    case "setQuorumBps":
    case "setApprovalBps":
    case "setVoteWindow":
    case "setRefundSweepDelay":
    case "setReleaseDelay":
      return encodeFunctionData({ abi: PlatformConfigAbi, functionName: spec.setter, args: [Number(v as bigint)] });
    case "setMinDonation":
      return encodeFunctionData({ abi: PlatformConfigAbi, functionName: spec.setter, args: [v as bigint] });
  }
}

/**
 * Decodes a payload back to (parameter, raw value) — only known setters with
 * in-bounds values; anything else is null. The record API accepts nothing else.
 */
export function decodeSetter(data: Hex): { spec: ParamSpec; value: RawValue } | null {
  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: PlatformConfigAbi, data });
  } catch {
    return null;
  }
  const spec = CONFIG_PARAMS.find((p) => p.setter === decoded.functionName);
  if (!spec || decoded.args?.length !== 1) return null;
  const arg = decoded.args[0];
  const value: RawValue | null =
    spec.kind === "address" ? (typeof arg === "string" ? (arg as Address) : null)
    : typeof arg === "bigint" ? arg
    : typeof arg === "number" ? BigInt(arg)
    : null;
  if (value === null) return null;
  // Re-encoding must give the same bytes (no trailing data, canonical form).
  const checked = checkRaw(spec, value);
  if (!checked.ok || encodeSetter(spec, checked.value).toLowerCase() !== data.toLowerCase()) return null;
  return { spec, value: checked.value };
}
