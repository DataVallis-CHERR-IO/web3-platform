/**
 * apps/agents/src/policy.ts
 * Signer policy (ADR-063 §2): what a crew wallet may sign. A transaction that
 * is not on this list is refused before it reaches the key — whatever a page,
 * a prompt or a model asked for.
 *
 * Allowed targets: campaigns of the amoy-dev factory, the Emergency Pool, the
 * factory (staff only) and Amoy USDC (approve to a campaign or the pool;
 * transfer inside the crew). Native POL moves only from the treasury to a crew
 * member, with no call data.
 */
import { decodeFunctionData, getAddress, type Abi, type Hex } from "viem";
import { CampaignAbi, CampaignFactoryAbi, EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { RATING_TYPES, ratingDomain } from "@cherrio/shared/ratings";
import type { Persona } from "./crew.js";

const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const satisfies Abi;

/** Campaign calls any crew member may send. Guardian calls are never signed by an agent. */
const CAMPAIGN_CALLS = new Set([
  "donate", "setPreference", "vote", "closeVote", "finalize", "release",
  "claimRefund", "settleToPool", "submitEvidence", "sweepUnclaimed",
]);
const CAMPAIGN_CALLS_STAFF = new Set(["setPayoutMode"]);
const POOL_CALLS = new Set(["donate", "voteAllocation", "closeAllocation", "reclaimFromCampaign"]);
const FACTORY_CALLS_STAFF = new Set(["createCampaign"]);

export interface PolicyContext {
  persona: Persona;
  chainId: number;
  expectedChainId: number;
  usdc: string;
  factory: string;
  pool: string;
  /** Every crew address (any case). */
  crew: readonly string[];
  /** CampaignFactory.isCampaign(addr), read from the chain. */
  isCampaign: (address: `0x${string}`) => Promise<boolean>;
}

export interface TxRequest {
  to?: string | null;
  data?: string | null;
  value?: string | bigint | null;
  /** Passed through to the signer as the page asked (hex quantities); not part of the policy. */
  gas?: string | null;
  maxFeePerGas?: string | null;
  maxPriorityFeePerGas?: string | null;
}

export type Verdict = { ok: true; what: string } | { ok: false; reason: string };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const refuse = (reason: string): Verdict => ({ ok: false, reason });

function decode(abi: Abi, data: Hex) {
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    return null;
  }
}

export async function checkTransaction(tx: TxRequest, ctx: PolicyContext): Promise<Verdict> {
  if (ctx.chainId !== ctx.expectedChainId) return refuse(`wrong chain ${ctx.chainId}`);
  if (!tx.to) return refuse("contract creation is not allowed");
  let to: `0x${string}`;
  try {
    to = getAddress(tx.to);
  } catch {
    return refuse("invalid target address");
  }
  const value = BigInt(tx.value ?? 0);
  const data = (tx.data && tx.data !== "0x" ? tx.data : null) as Hex | null;
  const inCrew = (a: string) => ctx.crew.some((c) => same(c, a));

  if (!data) {
    if (ctx.persona !== "treasury") return refuse("only the treasury sends POL");
    if (!inCrew(to)) return refuse("POL may go to crew members only");
    if (value <= 0n) return refuse("empty transaction");
    return { ok: true, what: "POL top-up" };
  }
  if (value !== 0n) return refuse("a contract call must not carry POL");

  if (same(to, ctx.usdc)) {
    const call = decode(erc20Abi, data);
    if (!call) return refuse("unknown USDC call");
    const [who] = call.args as readonly [`0x${string}`, bigint];
    if (call.functionName === "approve") {
      if (same(who, ctx.pool) || (await ctx.isCampaign(who))) return { ok: true, what: "USDC approve" };
      return refuse("USDC may be approved to a campaign or the pool only");
    }
    if (inCrew(who)) return { ok: true, what: "USDC transfer inside the crew" };
    return refuse("USDC may be transferred to crew members only");
  }

  if (same(to, ctx.pool)) {
    const call = decode(EmergencyPoolAbi as Abi, data);
    if (call && POOL_CALLS.has(call.functionName)) return { ok: true, what: `EmergencyPool.${call.functionName}` };
    return refuse(`EmergencyPool call not allowed: ${call?.functionName ?? "unknown"}`);
  }

  if (same(to, ctx.factory)) {
    const call = decode(CampaignFactoryAbi as Abi, data);
    if (call && ctx.persona === "staff" && FACTORY_CALLS_STAFF.has(call.functionName)) {
      return { ok: true, what: `CampaignFactory.${call.functionName}` };
    }
    return refuse(`CampaignFactory call not allowed: ${call?.functionName ?? "unknown"}`);
  }

  if (await ctx.isCampaign(to)) {
    const call = decode(CampaignAbi as Abi, data);
    if (!call) return refuse("unknown campaign call");
    if (CAMPAIGN_CALLS.has(call.functionName)) return { ok: true, what: `Campaign.${call.functionName}` };
    if (ctx.persona === "staff" && CAMPAIGN_CALLS_STAFF.has(call.functionName)) {
      return { ok: true, what: `Campaign.${call.functionName}` };
    }
    return refuse(`Campaign call not allowed: ${call.functionName}`);
  }

  return refuse(`target ${to} is not a CHERR.IO contract on this chain`);
}

/** Upper bounds for the fee fields a page may ask for (the bridge refuses anything above). */
export const FEE_CAPS = {
  gas: 3_000_000n,
  maxFeePerGas: 500_000_000_000n, // 500 gwei
  maxPriorityFeePerGas: 200_000_000_000n, // 200 gwei
} as const;

/**
 * The page's gas and fee fields: allowed only when each is a quantity within
 * FEE_CAPS — so a page cannot make a crew wallet burn its POL on fees.
 */
export function checkFees(tx: TxRequest): Verdict {
  for (const key of ["gas", "maxFeePerGas", "maxPriorityFeePerGas"] as const) {
    const raw = tx[key];
    if (raw === undefined || raw === null) continue;
    let value: bigint;
    try {
      value = BigInt(raw);
    } catch {
      return refuse(`invalid ${key}`);
    }
    if (value < 0n || value > FEE_CAPS[key]) return refuse(`${key} above the cap`);
  }
  return { ok: true, what: "fees within caps" };
}

/**
 * Typed data: only the app's own rating message (ADR-058) — domain, types and
 * primary type exactly as CHERR.IO builds them. Everything else is refused, in
 * particular EIP-2612 Permit, which would let a page move USDC without a
 * transaction the policy sees.
 */
export function checkTypedData(
  typed: { domain?: Record<string, unknown>; types?: Record<string, unknown>; primaryType?: string },
  chainId: number
): Verdict {
  if (typed.primaryType !== "Rating") return refuse(`typed data ${String(typed.primaryType)} is not allowed`);
  const want = ratingDomain(chainId);
  const domain = typed.domain ?? {};
  const keys = Object.keys(domain).sort();
  if (keys.join(",") !== "chainId,name,version") return refuse("unexpected typed-data domain fields");
  if (domain.name !== want.name || domain.version !== want.version || Number(domain.chainId) !== want.chainId) {
    return refuse("typed data for another domain");
  }
  const { EIP712Domain: _ignored, ...types } = typed.types ?? {};
  if (JSON.stringify(types) !== JSON.stringify(RATING_TYPES)) return refuse("unexpected typed-data types");
  return { ok: true, what: "rating" };
}

/**
 * Privy's sign-in message (EIP-4361). Signed only when it is for the testnet
 * host, this wallet and this chain — a sign-in for any other site is refused.
 */
export function checkSiweMessage(message: string, want: { host: string; address: string; chainId: number }): Verdict {
  const lines = message.split("\n");
  const first = /^(\S+) wants you to sign in with your Ethereum account:$/.exec(lines[0] ?? "");
  if (!first) return refuse("not a sign-in message");
  if (first[1] !== want.host) return refuse(`sign-in is for ${first[1]}, not ${want.host}`);
  if (!same((lines[1] ?? "").trim(), want.address)) return refuse("sign-in is for another address");
  const field = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
  const uri = field("URI");
  let uriHost: string | null = null;
  try {
    uriHost = uri ? new URL(uri).host : null;
  } catch {
    uriHost = null;
  }
  if (uriHost !== want.host) return refuse("sign-in URI is for another site");
  if (field("Chain ID") !== String(want.chainId)) return refuse("sign-in is for another chain");
  return { ok: true, what: "sign-in" };
}
