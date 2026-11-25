/**
 * apps/agents/test/core.test.ts
 * TASK-061a: the parts that keep the crew inside its limits — stable wallets,
 * dev only, the signer policy, the wallet bridge, top-ups, log redaction and
 * budget caps. No network: the chain is a stub.
 */
import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, verifyMessage } from "viem";
import { CampaignAbi, CampaignFactoryAbi, EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { CREW, deriveCrew, member } from "../src/crew.js";
import { GuardError, TESTNET_CHAIN_ID, TESTNET_HOST, assertTestnet } from "../src/guard.js";
import { checkSiweMessage, checkTransaction, type PolicyContext } from "../src/policy.js";
import { RefusedError, createBridge, injectedWalletScript, type BridgeEvent } from "../src/bridge.js";
import { DEFAULT_LEVELS, planTopUps, type Balance } from "../src/funding.js";
import { redact } from "../src/runlog.js";
import { BudgetExceeded, createBudget } from "../src/budget.js";

// The public Anvil/Hardhat phrase — known to everyone, holds nothing.
const PHRASE = "test test test test test test test test test test test junk";
const crew = deriveCrew(PHRASE);

const USDC = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";
const FACTORY = "0x00000000000000000000000000000000000000f1";
const POOL = "0x00000000000000000000000000000000000000e1";
const CAMPAIGN = "0x00000000000000000000000000000000000000c1";
const STRANGER = "0x00000000000000000000000000000000000000dd";

const ctx = (persona: PolicyContext["persona"], chainId = TESTNET_CHAIN_ID): PolicyContext => ({
  persona, chainId, expectedChainId: TESTNET_CHAIN_ID, usdc: USDC, factory: FACTORY, pool: POOL,
  crew: crew.map((m) => m.address),
  isCampaign: async (a) => a.toLowerCase() === CAMPAIGN,
});
const campaignCall = (functionName: string, args: unknown[] = []) =>
  encodeFunctionData({ abi: CampaignAbi, functionName, args } as never);

describe("crew", () => {
  it("derives the same addresses every time, one per index", () => {
    expect(crew.map((m) => m.index)).toEqual(CREW.map((c) => c.index));
    expect(member(crew, "treasury").address).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    expect(member(crew, "staff").address).toBe("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    expect(new Set(crew.map((m) => m.address)).size).toBe(CREW.length);
    expect(deriveCrew(`  ${PHRASE}  `).map((m) => m.address)).toEqual(crew.map((m) => m.address));
  });
  it("rejects a bad phrase without echoing it", () => {
    expect(() => deriveCrew("one two three")).toThrow("12- or 24-word");
    try { deriveCrew("one two three"); } catch (e) { expect(String(e)).not.toContain("two"); }
  });
});

describe("guard", () => {
  it("accepts the testnet on Amoy only", () => {
    expect(() => assertTestnet({ origin: "https://testnet.cherr.io", chainId: 80002 })).not.toThrow();
    expect(() => assertTestnet({ origin: "https://testnet.cherr.io/en", chainId: 80002 })).not.toThrow();
    for (const origin of ["https://app.cherr.io", "https://uat.cherr.io", "https://cherr.io", "http://testnet.cherr.io", "https://testnet.cherr.io.evil.example", "nonsense"]) {
      expect(() => assertTestnet({ origin, chainId: 80002 }), origin).toThrow(GuardError);
    }
    expect(() => assertTestnet({ origin: "https://testnet.cherr.io", chainId: 137 })).toThrow(GuardError);
  });
});

describe("signer policy", () => {
  it("lets a donor approve USDC to a campaign and donate", async () => {
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CAMPAIGN, 5_000_000n] });
    expect(await checkTransaction({ to: USDC, data: approve }, ctx("donor"))).toEqual({ ok: true, what: "USDC approve" });
    expect(await checkTransaction({ to: CAMPAIGN, data: campaignCall("donate", [5_000_000n, 0, 0]) }, ctx("donor")))
      .toEqual({ ok: true, what: "Campaign.donate" });
    expect((await checkTransaction({ to: CAMPAIGN, data: campaignCall("vote", [true]) }, ctx("donor"))).ok).toBe(true);
  });
  it("refuses USDC to a stranger, by approve or transfer", async () => {
    for (const functionName of ["approve", "transfer"] as const) {
      const data = encodeFunctionData({ abi: erc20Abi, functionName, args: [STRANGER, 1n] });
      expect((await checkTransaction({ to: USDC, data }, ctx("donor"))).ok, functionName).toBe(false);
    }
    const inside = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [crew[0]!.address, 1n] });
    expect((await checkTransaction({ to: USDC, data: inside }, ctx("fundraiser"))).ok).toBe(true);
  });
  it("refuses a contract that is not ours, contract creation and calls with POL", async () => {
    expect(await checkTransaction({ to: STRANGER, data: campaignCall("donate", [1n, 0, 0]) }, ctx("donor")))
      .toMatchObject({ ok: false, reason: expect.stringContaining("not a CHERR.IO contract") });
    expect((await checkTransaction({ data: "0x6000" }, ctx("staff"))).ok).toBe(false);
    expect((await checkTransaction({ to: CAMPAIGN, data: campaignCall("finalize"), value: 1n }, ctx("donor"))).ok).toBe(false);
  });
  it("never signs Guardian calls, for anyone", async () => {
    for (const persona of ["donor", "staff", "treasury"] as const) {
      expect((await checkTransaction({ to: CAMPAIGN, data: campaignCall("freeze") }, ctx(persona))).ok, persona).toBe(false);
      expect((await checkTransaction({ to: CAMPAIGN, data: campaignCall("resolve", [true]) }, ctx(persona))).ok, persona).toBe(false);
    }
    const resolveAllocation = encodeFunctionData({ abi: EmergencyPoolAbi, functionName: "resolveAllocation", args: [1n, true] });
    expect((await checkTransaction({ to: POOL, data: resolveAllocation }, ctx("staff"))).ok).toBe(false);
  });
  it("keeps Operator calls to the staff agent", async () => {
    const create = encodeFunctionData({
      abi: CampaignFactoryAbi, functionName: "createCampaign",
      args: [{ offchainId: `0x${"11".repeat(32)}`, beneficiary: crew[2]!.address, target: 100_000_000n, deadline: 1_900_000_000n, beneficiaryType: 0 }],
    });
    expect((await checkTransaction({ to: FACTORY, data: create }, ctx("staff"))).ok).toBe(true);
    expect((await checkTransaction({ to: FACTORY, data: create }, ctx("fundraiser"))).ok).toBe(false);
    expect((await checkTransaction({ to: CAMPAIGN, data: campaignCall("setPayoutMode", [1]) }, ctx("staff"))).ok).toBe(true);
    expect((await checkTransaction({ to: CAMPAIGN, data: campaignCall("setPayoutMode", [1]) }, ctx("donor"))).ok).toBe(false);
  });
  it("sends POL only from the treasury to the crew", async () => {
    expect((await checkTransaction({ to: crew[4]!.address, value: 10n }, ctx("treasury"))).ok).toBe(true);
    expect((await checkTransaction({ to: STRANGER, value: 10n }, ctx("treasury"))).ok).toBe(false);
    expect((await checkTransaction({ to: crew[4]!.address, value: 10n }, ctx("donor"))).ok).toBe(false);
  });
  it("refuses everything on another chain", async () => {
    expect(await checkTransaction({ to: CAMPAIGN, data: campaignCall("finalize") }, ctx("donor", 137)))
      .toEqual({ ok: false, reason: "wrong chain 137" });
  });
});

const siwe = (host: string, address: string, chainId: number, uri = `https://${host}`) =>
  `${host} wants you to sign in with your Ethereum account:\n${address}\n\nBy signing, you are proving you own this wallet and logging in.\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: abc123\nIssued At: 2026-11-24T10:00:00.000Z`;

describe("sign-in message", () => {
  const me = crew[4]!.account.address;
  const want = { host: TESTNET_HOST, address: me, chainId: TESTNET_CHAIN_ID };
  it("accepts the testnet's own message for this wallet and chain", () => {
    expect(checkSiweMessage(siwe(TESTNET_HOST, me, 80002), want).ok).toBe(true);
  });
  it("refuses another site, address, chain or URI", () => {
    expect(checkSiweMessage(siwe("evil.example", me, 80002), want).ok).toBe(false);
    expect(checkSiweMessage(siwe(TESTNET_HOST, STRANGER, 80002), want).ok).toBe(false);
    expect(checkSiweMessage(siwe(TESTNET_HOST, me, 137), want).ok).toBe(false);
    expect(checkSiweMessage(siwe(TESTNET_HOST, me, 80002, "https://evil.example"), want).ok).toBe(false);
    expect(checkSiweMessage("Please sign this to claim your airdrop", want).ok).toBe(false);
  });
});

describe("wallet bridge", () => {
  const donor = crew[4]!;
  function bridge() {
    const events: BridgeEvent[] = [];
    const send = vi.fn(async () => `0x${"ab".repeat(32)}` as const);
    const rpc = vi.fn(async (method: string) => (method === "eth_blockNumber" ? "0x10" : null));
    const request = createBridge({ account: donor.account, host: TESTNET_HOST, policy: ctx("donor"), rpc, send, onEvent: (e) => events.push(e) });
    return { request, events, send, rpc };
  }
  it("answers identity, forwards reads, refuses unknown methods", async () => {
    const { request, rpc } = bridge();
    expect(await request("eth_chainId")).toBe("0x13882");
    expect(await request("eth_requestAccounts")).toEqual([donor.account.address]);
    expect(await request("eth_blockNumber")).toBe("0x10");
    expect(rpc).toHaveBeenCalledWith("eth_blockNumber", []);
    await expect(request("eth_sign", [donor.address, "0x00"])).rejects.toBeInstanceOf(RefusedError);
    await expect(request("wallet_switchEthereumChain", [{ chainId: "0x89" }])).rejects.toBeInstanceOf(RefusedError);
    expect(await request("wallet_switchEthereumChain", [{ chainId: "0x13882" }])).toBeNull();
  });
  it("signs the testnet sign-in with the agent's key and nothing else", async () => {
    const { request, events } = bridge();
    const message = siwe(TESTNET_HOST, donor.account.address, 80002);
    const hex = `0x${Buffer.from(message, "utf8").toString("hex")}`;
    const signature = (await request("personal_sign", [hex, donor.account.address])) as `0x${string}`;
    expect(await verifyMessage({ address: donor.account.address, message, signature })).toBe(true);
    await expect(request("personal_sign", ["I agree to transfer everything", donor.account.address])).rejects.toBeInstanceOf(RefusedError);
    expect(events.map((e) => e.outcome)).toEqual(["signed", "refused"]);
  });
  it("sends an allowed transaction and never sends a refused one", async () => {
    const { request, send, events } = bridge();
    const hash = await request("eth_sendTransaction", [{ from: donor.address, to: CAMPAIGN, data: campaignCall("donate", [1_000_000n, 0, 0]) }]);
    expect(hash).toBe(`0x${"ab".repeat(32)}`);
    expect(send).toHaveBeenCalledTimes(1);
    const drain = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [STRANGER, 999n] });
    await expect(request("eth_sendTransaction", [{ from: donor.address, to: USDC, data: drain }])).rejects.toBeInstanceOf(RefusedError);
    await expect(request("eth_sendTransaction", [{ from: STRANGER, to: CAMPAIGN, data: campaignCall("finalize") }])).rejects.toBeInstanceOf(RefusedError);
    expect(send).toHaveBeenCalledTimes(1);
    expect(events.at(-2)).toMatchObject({ outcome: "refused", to: USDC });
  });
  it("refuses typed data for another chain", async () => {
    const { request } = bridge();
    const typed = JSON.stringify({ domain: { name: "X", chainId: 1 }, types: { EIP712Domain: [], M: [{ name: "a", type: "uint256" }] }, primaryType: "M", message: { a: 1 } });
    await expect(request("eth_signTypedData_v4", [donor.address, typed])).rejects.toBeInstanceOf(RefusedError);
  });
  it("the page script holds no key and announces the wallet", async () => {
    const { AS_METAMASK } = await import("../src/bridge.js");
    const asMetaMask = injectedWalletScript(AS_METAMASK);
    expect(asMetaMask).toContain('"io.metamask"');
    expect(asMetaMask).toContain("isMetaMask: true");
    expect(asMetaMask).not.toMatch(/[0-9a-f]{64}/);
    const script = injectedWalletScript();
    expect(script).toContain("eip6963:announceProvider");
    expect(script).toContain("window.__agentWallet");
    expect(() => new Function(script)).not.toThrow(); // parses
  });
});

describe("top-ups", () => {
  const w = (name: string, pol: bigint, usdc: bigint): Balance => ({ name, address: `0x${"0".repeat(39)}1`, pol, usdc });
  const POL = 10n ** 18n;
  it("tops up only what is below the floor, USDC only for spenders", () => {
    const plan = planTopUps(w("treasury", 5n * POL, 500_000_000n), [
      w("staff", 0n, 0n), w("donor-1", POL, 2_000_000n), w("donor-2", POL, 50_000_000n),
    ]);
    expect(plan.ok).toBe(true);
    expect(plan.transfers).toEqual([
      expect.objectContaining({ name: "staff", asset: "POL", amount: DEFAULT_LEVELS.pol.target }),
      expect.objectContaining({ name: "donor-1", asset: "USDC", amount: 38_000_000n }),
    ]);
    expect(plan.total).toEqual({ pol: DEFAULT_LEVELS.pol.target, usdc: 38_000_000n });
  });
  it("reports a shortfall instead of a partial plan, keeping the treasury's gas", () => {
    const plan = planTopUps(w("treasury", DEFAULT_LEVELS.treasuryReservePol + 1n, 1_000_000n), [w("donor-1", 0n, 0n)]);
    expect(plan.ok).toBe(false);
    expect(plan.shortfall.pol).toBe(DEFAULT_LEVELS.pol.target - 1n);
    expect(plan.shortfall.usdc).toBe(39_000_000n);
  });
});

describe("run log", () => {
  it("removes anything shaped like a key or a seed phrase, keeps tx hashes", () => {
    const hash = `0x${"cd".repeat(32)}`;
    const out = redact({ note: `key 0x${"ab".repeat(32)} and ${PHRASE}`, hash, nested: [{ error: "ab".repeat(32) }], amount: 5n }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("ab".repeat(32));
    expect(JSON.stringify(out)).not.toContain("junk");
    expect(out.hash).toBe(hash);
    expect(out.amount).toBe("5");
  });
});

describe("budget", () => {
  it("stops at the cap and not one action later", () => {
    const budget = createBudget({ llmTokens: 100, transactions: 2, campaigns: 1, organisations: 1 });
    budget.spend("transactions");
    budget.spend("transactions");
    expect(() => budget.spend("transactions")).toThrow(BudgetExceeded);
    expect(() => budget.spend("llmTokens", 101)).toThrow("llmTokens");
    expect(budget.used()).toMatchObject({ transactions: 2, llmTokens: 0 });
  });
});

describe("model routing", () => {
  const agents = crew.map((m) => m.name);
  it("puts the dispatcher on Opus, routine work on the cheapest model, fixed steps on none", async () => {
    const { modelFor, placeAssignments } = await import("../src/models.js");
    expect(modelFor("dispatcher", {})).toBe("claude-opus-5-5");
    expect(modelFor("routine", { AGENT_MODEL_ROUTINE: " other-model " })).toBe("other-model");
    const placed = placeAssignments([
      { task: "donate", agent: "donor-1" },
      { task: "start-campaign", agent: "fundraiser-1", tier: "routine" },
      { task: "publish-campaign", agent: "staff" },
      { task: "review-submission", agent: "staff" },
    ], agents, {});
    expect(placed.map((p) => p.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", null, "claude-sonnet-5-5"]);
  });
  it("rejects a plan that spends more, weakens the review or invents things", async () => {
    const { placeAssignments } = await import("../src/models.js");
    const bad = [
      [{ task: "donate", agent: "donor-1", tier: "dispatcher" }],
      [{ task: "donate", agent: "donor-1", tier: "explore" }],
      [{ task: "publish-campaign", agent: "staff", tier: "routine" }],
      [{ task: "review-submission", agent: "staff", tier: "routine" }],
      [{ task: "donate", agent: "donor-1", tier: "none" }],
      [{ task: "drain-wallet", agent: "donor-1" }],
      [{ task: "donate", agent: "someone-else" }],
      "donate everything",
    ];
    for (const plan of bad) expect(() => placeAssignments(plan, agents, {}), JSON.stringify(plan)).toThrow();
  });
});

describe("061b additions", () => {
  it("the run log removes the RPC URL (its API key) given as a secret", () => {
    const url = "https://polygon-amoy.g.alchemy.com/v2/abcDEF123456";
    const out = JSON.stringify(redact({ error: `request to ${url} failed`, nested: { u: url } }, undefined, [url]));
    expect(out).not.toContain("abcDEF123456");
    expect(out).toContain("[redacted]");
  });
  it("the bridge hands the page's fee fields to the signer unchanged", async () => {
    const send = vi.fn(async () => `0x${"ab".repeat(32)}` as const);
    const request = createBridge({ account: crew[4]!.account, host: TESTNET_HOST, policy: ctx("donor"), rpc: async () => null, send });
    const tx = { from: crew[4]!.address, to: CAMPAIGN, data: campaignCall("finalize"), gas: "0x5208", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1" };
    await request("eth_sendTransaction", [tx]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ gas: "0x5208", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1" }));
  });
});

describe("review fixes (typed data, fees)", () => {
  it("signs only the app's own rating message, never a USDC Permit", async () => {
    const { checkTypedData } = await import("../src/policy.js");
    const { ratingTypedData } = await import("@cherrio/shared/ratings");
    const rating = ratingTypedData(80002, { campaign: CAMPAIGN, organization: "org", stars: 5, comment: null, issuedAt: 1 } as never);
    expect(checkTypedData(rating as never, 80002).ok).toBe(true);
    const permit = {
      domain: { name: "USDC", version: "2", chainId: 80002, verifyingContract: USDC },
      types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Permit",
    };
    expect(checkTypedData(permit, 80002).ok).toBe(false);
    // A "Rating" dressed with a verifying contract is refused too.
    expect(checkTypedData({ ...rating, domain: { ...rating.domain, verifyingContract: USDC } } as never, 80002).ok).toBe(false);
    expect(checkTypedData(rating as never, 137).ok).toBe(false);
    // Only the primary type differs: the primary-type rule alone must refuse it.
    expect(checkTypedData({ ...rating, primaryType: "Permit" } as never, 80002).ok).toBe(false);
  });
  it("the bridge refuses a Permit and typed data for another address", async () => {
    const donor = crew[4]!;
    const request = createBridge({ account: donor.account, host: TESTNET_HOST, policy: ctx("donor"), rpc: async () => null, send: async () => "0x00" as `0x${string}` });
    const permit = JSON.stringify({ domain: { name: "USDC", version: "2", chainId: 80002, verifyingContract: USDC }, types: { EIP712Domain: [], Permit: [] }, primaryType: "Permit", message: {} });
    await expect(request("eth_signTypedData_v4", [donor.address, permit])).rejects.toBeInstanceOf(RefusedError);
    const { ratingTypedData } = await import("@cherrio/shared/ratings");
    const rating = JSON.stringify(ratingTypedData(80002, { campaign: CAMPAIGN, organization: "org", stars: 5, comment: null, issuedAt: 1 } as never));
    await expect(request("eth_signTypedData_v4", [STRANGER, rating])).rejects.toBeInstanceOf(RefusedError);
    expect(typeof (await request("eth_signTypedData_v4", [donor.address, rating]))).toBe("string");
  });
  it("refuses fees above the caps and never sends such a transaction", async () => {
    const send = vi.fn(async () => `0x${"ab".repeat(32)}` as const);
    const request = createBridge({ account: crew[4]!.account, host: TESTNET_HOST, policy: ctx("donor"), rpc: async () => null, send });
    const base = { from: crew[4]!.address, to: CAMPAIGN, data: campaignCall("finalize") };
    await expect(request("eth_sendTransaction", [{ ...base, maxFeePerGas: "0x174876e8000" }])).rejects.toBeInstanceOf(RefusedError); // 1,600 gwei
    await expect(request("eth_sendTransaction", [{ ...base, gas: "0x1c9c380" }])).rejects.toBeInstanceOf(RefusedError); // 30,000,000
    await expect(request("eth_sendTransaction", [{ ...base, gas: "lots" }])).rejects.toBeInstanceOf(RefusedError);
    expect(send).not.toHaveBeenCalled();
  });
});
