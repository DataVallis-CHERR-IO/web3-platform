/**
 * apps/agents/src/cli.ts
 *   pnpm --filter agents addresses         print the crew's PUBLIC addresses
 *   pnpm --filter agents fund [--send]     show (or send) the treasury top-ups
 *
 * Reads AGENT_MNEMONIC from the environment and never prints it. `fund` also
 * needs AGENT_RPC_URL (an Amoy RPC of the agents' own). Without --send it only
 * prints the plan.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatUnits, http } from "viem";
import { polygonAmoy } from "viem/chains";
import { requireContracts } from "@cherrio/shared/env";
import { AMOY_USDC_ADDRESS } from "@cherrio/shared/chains";
import { CampaignFactoryAbi } from "@cherrio/contracts/abis";
import { deriveCrew, member } from "./crew.js";
import { TESTNET_CHAIN_ID, TESTNET_ORIGIN, assertTestnet } from "./guard.js";
import { planTopUps, type Balance } from "./funding.js";
import { checkTransaction, type PolicyContext } from "./policy.js";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  const crew = deriveCrew(need("AGENT_MNEMONIC"));

  if (command === "addresses") {
    for (const m of crew) console.log(`${String(m.index).padStart(2)}  ${m.name.padEnd(13)} ${m.address}`);
    return;
  }

  if (command === "fund") {
    const transport = http(need("AGENT_RPC_URL"));
    const client = createPublicClient({ chain: polygonAmoy, transport });
    assertTestnet({ origin: TESTNET_ORIGIN, chainId: await client.getChainId() });
    const contracts = requireContracts("dev");
    const factory = contracts.campaignFactory?.address as `0x${string}` | undefined;
    const pool = contracts.emergencyPool?.address as `0x${string}` | undefined;
    if (!factory || !pool) throw new Error("amoy-dev deployment has no factory or pool address");
    const balanceOf = async (m: (typeof crew)[number]): Promise<Balance> => ({
      name: m.name,
      address: m.address,
      pol: await client.getBalance({ address: m.address }),
      usdc: await client.readContract({ address: AMOY_USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [m.address] }),
    });
    const treasury = member(crew, "treasury");
    const all = await Promise.all(crew.map(balanceOf));
    const plan = planTopUps(all[0]!, all.slice(1));
    for (const b of all) console.log(`${b.name.padEnd(13)} ${formatUnits(b.pol, 18).padStart(10)} POL ${formatUnits(b.usdc, 6).padStart(10)} USDC`);
    for (const t of plan.transfers) console.log(`→ ${t.name.padEnd(13)} ${formatUnits(t.amount, t.asset === "POL" ? 18 : 6)} ${t.asset}`);
    if (!plan.ok) {
      console.error(`Treasury ${treasury.address} is short by ${formatUnits(plan.shortfall.pol, 18)} POL and ${formatUnits(plan.shortfall.usdc, 6)} USDC — nothing sent.`);
      process.exitCode = 1;
      return;
    }
    if (!flags.includes("--send")) {
      console.log(`${plan.transfers.length} transfer(s) planned. Run again with --send to send them.`);
      return;
    }
    const policy: PolicyContext = {
      persona: "treasury", chainId: TESTNET_CHAIN_ID, expectedChainId: TESTNET_CHAIN_ID,
      usdc: AMOY_USDC_ADDRESS, factory, pool,
      crew: crew.map((m) => m.address),
      isCampaign: (address) => client.readContract({ address: factory, abi: CampaignFactoryAbi, functionName: "isCampaign", args: [address] }),
    };
    const wallet = createWalletClient({ account: treasury.account, chain: polygonAmoy, transport });
    for (const t of plan.transfers) {
      const tx = t.asset === "POL"
        ? { to: t.to, value: t.amount }
        : { to: AMOY_USDC_ADDRESS, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [t.to, t.amount] }) };
      const verdict = await checkTransaction(tx, policy);
      if (!verdict.ok) throw new Error(`policy refused a top-up: ${verdict.reason}`);
      const hash = await wallet.sendTransaction(tx);
      await client.waitForTransactionReceipt({ hash });
      console.log(`sent ${t.asset} to ${t.name}: ${hash}`);
    }
    return;
  }

  console.error("usage: cli.ts addresses | fund [--send]");
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  // Message only: a stack or the error object could carry request details.
  console.error(error instanceof Error ? error.message : "failed");
  process.exitCode = 1;
});
