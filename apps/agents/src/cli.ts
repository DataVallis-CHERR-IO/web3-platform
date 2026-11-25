/**
 * apps/agents/src/cli.ts
 *   pnpm --filter agents addresses         print the crew's PUBLIC addresses
 *   pnpm --filter agents fund [--send]     show (or send) the treasury top-ups
 *   pnpm --filter agents enrol-staff [--dir <folder>]
 *                                          sign in as the staff agent and set up its admin authenticator
 *
 * Reads AGENT_MNEMONIC from the environment and never prints it. `fund` and
 * `enrol-staff` also need AGENT_RPC_URL (an Amoy RPC of the agents' own).
 * Without --send `fund` only prints the plan. `enrol-staff` writes the staff
 * agent's authenticator key and recovery codes to two files (0600) and prints
 * only their paths (docs/technical/11-testnet-agents.md, "Staff agent").
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatUnits, http } from "viem";
import { polygonAmoy } from "viem/chains";
import { requireContracts } from "@cherrio/shared/env";
import { AMOY_USDC_ADDRESS } from "@cherrio/shared/chains";
import { CampaignFactoryAbi } from "@cherrio/contracts/abis";
import { assertCrewMatchesRegistry, deriveCrew, member } from "./crew.js";
import { connectChain } from "./chain.js";
import { openSession, signIn } from "./browser.js";
import { adminGate, base32Decode, enrolSecondFactor, passSecondFactor, saveEnrolment } from "./staff.js";
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

  if (command === "enrol-staff") {
    process.exitCode = await enrolStaff(crew, flags);
    return;
  }

  console.error("usage: cli.ts addresses | fund [--send] | enrol-staff [--dir <folder>]");
  process.exitCode = 2;
}

const REPO = "DataVallis-CHERR-IO/web3-platform";

/**
 * 1st run: the staff agent signs in (the user row is created), /en/admin is
 * 404 → David runs grant-admin. 2nd run: the enrolment screen → key + recovery
 * codes to files, then the key is checked once more through the code screen.
 */
async function enrolStaff(crew: ReturnType<typeof deriveCrew>, flags: string[]): Promise<number> {
  assertCrewMatchesRegistry(crew);
  const staff = member(crew, "staff");
  const dirFlag = flags.indexOf("--dir");
  const dir = dirFlag >= 0 && flags[dirFlag + 1] ? flags[dirFlag + 1]! : join(homedir(), ".cherrio");
  const paths = { secret: join(dir, "agent-staff-totp-secret.txt"), recovery: join(dir, "agent-staff-recovery-codes.txt") };
  const chain = await connectChain(need("AGENT_RPC_URL"));
  // Login screenshots only (signIn); none after it, the enrolment screen shows the key.
  const out = mkdtempSync(join(tmpdir(), "cherrio-staff-"));
  const browser = await chromium.launch();
  try {
    const session = await openSession({ browser, member: staff, crew, chain, rpcUrl: need("AGENT_RPC_URL"), out });
    const ok = await signIn(session, staff, out, (step, passed, detail) => console.log(`${passed ? "✓" : "✗"} ${step}: ${detail}`), (l) => console.log(l));
    if (!ok) return 1;
    const state = await adminGate(session.page);
    if (state === "not-admin") {
      console.log(`The staff agent ${staff.address} has signed in, but it is not an admin yet (/en/admin → 404).`);
      console.log(`Next: grant PLATFORM_ADMIN on the dev server (docs/CHEATSHEET.md, "Admin panel"):`);
      console.log(`  docker exec <container-name> node packages/db/dist/grant-admin.mjs ${staff.address}`);
      console.log("Then run this command again.");
      return 3;
    }
    if (state === "verify") {
      const stored = process.env.AGENT_STAFF_TOTP_SECRET;
      if (!stored) {
        console.log("The staff agent already has an authenticator. Set AGENT_STAFF_TOTP_SECRET to check it, or reset it with");
        console.log(`  docker exec <container-name> node packages/db/dist/reset-admin-mfa.mjs ${staff.address}`);
        return 3;
      }
      await passSecondFactor(session.page, base32Decode(stored));
      console.log("✓ AGENT_STAFF_TOTP_SECRET opens the admin area.");
      return 0;
    }
    if (state === "open") {
      console.log("✓ The admin area is already open for the staff agent (a valid 12-hour proof).");
      return 0;
    }
    const enrolled = await enrolSecondFactor(session.page);
    saveEnrolment(enrolled, paths); // first: the factor is confirmed now, the key must not be lost
    console.log("✓ authenticator set up; key and recovery codes saved (0600):");
    console.log(`  ${paths.secret}`);
    console.log(`  ${paths.recovery}`);
    // The saved key must open the gate on its own: drop the 12-hour proof and pass the code screen.
    await session.context.clearCookies({ name: "cherrio_admin_mfa" });
    const again = await adminGate(session.page);
    if (again !== "verify") throw new Error(`after the enrolment /en/admin shows "${again}", not the code screen`);
    console.log("… waiting for the next 30-second code to check the saved key");
    await passSecondFactor(session.page, base32Decode(enrolled.secret), enrolled.step);
    console.log("✓ the saved key opens the admin area");
    console.log("Next: store the key as the GitHub secret (keep your own copy of both files — GitHub never shows a secret again):");
    console.log(`  gh secret set AGENT_STAFF_TOTP_SECRET --env agents --repo ${REPO} < ${paths.secret}`);
    return 0;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  // Message only: a stack or the error object could carry request details.
  console.error(error instanceof Error ? error.message : "failed");
  process.exitCode = 1;
});
