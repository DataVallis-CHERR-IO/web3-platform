/**
 * apps/agents/src/chain.ts
 * Chain access for a run: the agents' own RPC (AGENT_RPC_URL), the amoy-dev
 * contracts and the signer-policy context for one crew member.
 */
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { polygonAmoy } from "viem/chains";
import { requireContracts } from "@cherrio/shared/env";
import { AMOY_USDC_ADDRESS } from "@cherrio/shared/chains";
import { CampaignFactoryAbi } from "@cherrio/contracts/abis";
import type { CrewMember } from "./crew.js";
import { TESTNET_CHAIN_ID, TESTNET_ORIGIN, assertTestnet } from "./guard.js";
import type { PolicyContext, TxRequest } from "./policy.js";

export interface Chain {
  client: PublicClient;
  usdc: `0x${string}`;
  factory: `0x${string}`;
  pool: `0x${string}`;
  isCampaign: (address: `0x${string}`) => Promise<boolean>;
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
}

export async function connectChain(rpcUrl: string): Promise<Chain> {
  const client = createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl, { timeout: 20_000 }) }) as PublicClient;
  assertTestnet({ origin: TESTNET_ORIGIN, chainId: await client.getChainId() });
  const contracts = requireContracts("dev");
  const factory = contracts.campaignFactory?.address as `0x${string}` | undefined;
  const pool = contracts.emergencyPool?.address as `0x${string}` | undefined;
  if (!factory || !pool) throw new Error("amoy-dev deployment has no factory or pool address");
  const known = new Map<string, boolean>();
  return {
    client,
    usdc: AMOY_USDC_ADDRESS,
    factory,
    pool,
    async isCampaign(address) {
      const key = address.toLowerCase();
      if (!known.has(key)) {
        known.set(key, await client.readContract({ address: factory, abi: CampaignFactoryAbi, functionName: "isCampaign", args: [address] }));
      }
      return known.get(key)!;
    },
    async rpc(method, params) {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
      return body.result;
    },
  };
}

export function policyFor(member: CrewMember, crew: CrewMember[], chain: Chain): PolicyContext {
  return {
    persona: member.persona,
    chainId: TESTNET_CHAIN_ID,
    expectedChainId: TESTNET_CHAIN_ID,
    usdc: chain.usdc,
    factory: chain.factory,
    pool: chain.pool,
    crew: crew.map((m) => m.address),
    isCampaign: chain.isCampaign,
  };
}

const big = (hex?: string | null) => (hex ? BigInt(hex) : undefined);

/** Signs and sends an allowed transaction with the member's key; fees as the page asked. */
export function senderFor(member: CrewMember, rpcUrl: string) {
  const wallet = createWalletClient({ account: member.account, chain: polygonAmoy, transport: http(rpcUrl, { timeout: 20_000 }) });
  return (tx: TxRequest) =>
    wallet.sendTransaction({
      to: tx.to as `0x${string}`,
      data: (tx.data ?? undefined) as Hex | undefined,
      value: typeof tx.value === "bigint" ? tx.value : big(tx.value as string | null) ?? 0n,
      gas: big(tx.gas),
      maxFeePerGas: big(tx.maxFeePerGas),
      maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas),
    } as Parameters<typeof wallet.sendTransaction>[0]);
}
