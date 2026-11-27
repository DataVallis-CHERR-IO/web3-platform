import { describe, expect, it } from "vitest";
import {
  BUTTON_NAME, MAX_LIFECYCLE_ACTIONS_PER_RUN, crewCampaignsForLifecycle, isCrewLifecycleCampaign, nextLifecycleAction,
  type LifecycleCampaign, type LifecycleJson,
} from "../src/lifecycle.js";

// TASK-061g: the decision and the campaign filter. No network: fetch is a fake.

const ME = { address: "0x00000000000000000000000000000000000000aa" as const };
const OTHER = "0x00000000000000000000000000000000000000bb";
const noDue = { finalize: false, closeVote: false, release: false };
type Pos = NonNullable<LifecycleJson["positions"]>[number];
const pos = (p: Partial<Pos> & { action: Pos["action"] }): Pos =>
  ({ address: ME.address, donated: "5000000", preference: "REFUND", settled: false, vote: null, ...p });
const lc = (state: string, due: Partial<typeof noDue> = {}, positions: LifecycleJson["positions"] = null): LifecycleJson =>
  ({ lifecycle: { state, round: null, due: { ...noDue, ...due } }, positions });

describe("nextLifecycleAction", () => {
  it("finalizes after the deadline, releases when due, counts votes when the vote is over", () => {
    expect(nextLifecycleAction(lc("LIVE", { finalize: true }), ME).kind).toBe("finalize");
    expect(nextLifecycleAction(lc("SUCCEEDED", { release: true }), ME).kind).toBe("release");
    expect(nextLifecycleAction(lc("VOTING", { closeVote: true }), ME).kind).toBe("close-vote");
  });

  it("does nothing when nothing is due, with a reason", () => {
    const a = nextLifecycleAction(lc("SUCCEEDED"), ME);
    expect(a.kind).toBe("none");
    expect(a.reason).toContain("SUCCEEDED");
    expect(nextLifecycleAction(lc("COMPLETED"), ME).kind).toBe("none");
  });

  it("votes approve when this member donated and has not voted this round", () => {
    const j = lc("VOTING", {}, [pos({ action: { kind: "vote" } })]);
    expect(nextLifecycleAction(j, ME).kind).toBe("vote-approve");
  });

  it("never votes twice in a round, and never without a donation", () => {
    const voted = lc("VOTING", {}, [pos({ vote: { approve: true, weight: "5000000" }, action: { kind: "voted" } })]);
    expect(nextLifecycleAction(voted, ME).kind).toBe("none");
    const noDonation = lc("VOTING", {}, [pos({ donated: "0", action: { kind: "none" } })]);
    expect(nextLifecycleAction(noDonation, ME).kind).toBe("none");
    const someoneElse = lc("VOTING", {}, [pos({ address: OTHER, action: { kind: "vote" } })]);
    expect(nextLifecycleAction(someoneElse, ME).kind).toBe("none");
    expect(nextLifecycleAction(lc("VOTING"), ME).kind).toBe("none"); // logged out: no positions
  });

  it("only ever approves: no action kind rejects", () => {
    const j = lc("VOTING", {}, [pos({ action: { kind: "vote" } })]);
    expect(nextLifecycleAction(j, ME).kind).not.toMatch(/reject|no/);
    expect(Object.keys(BUTTON_NAME)).not.toContain("vote-reject");
  });

  it("refunds on REFUND, sends to the pool on POOL, only for its own position", () => {
    const refund = lc("FAILED", {}, [pos({ preference: "REFUND", action: { kind: "refund", amount: "5000000" } })]);
    expect(nextLifecycleAction(refund, ME).kind).toBe("refund");
    const pool = lc("REJECTED", {}, [pos({ preference: "POOL", action: { kind: "pool", amount: "4000000" } })]);
    expect(nextLifecycleAction(pool, ME).kind).toBe("settle-to-pool");
    const others = lc("FAILED", {}, [pos({ address: OTHER, action: { kind: "refund", amount: "1" } })]);
    expect(nextLifecycleAction(others, ME).kind).toBe("none");
    const settled = lc("FAILED", {}, [pos({ settled: true, action: { kind: "settled" } })]);
    expect(nextLifecycleAction(settled, ME).kind).toBe("none");
  });

  it("matches the address case-insensitively and prefers its own position over a trigger", () => {
    const j = lc("VOTING", { closeVote: false }, [pos({ address: ME.address.toUpperCase().replace("0X", "0x"), action: { kind: "vote" } })]);
    expect(nextLifecycleAction(j, ME).kind).toBe("vote-approve");
  });

  it("every action has a button name from the panel's texts", () => {
    expect("Approve payment 2").toMatch(BUTTON_NAME["vote-approve"]);
    expect("Get your money back (5 USDC)").toMatch(BUTTON_NAME.refund);
    expect("Send 5 USDC to the Emergency Pool").toMatch(BUTTON_NAME["settle-to-pool"]);
    expect("Reject").not.toMatch(BUTTON_NAME["vote-approve"]);
    expect(MAX_LIFECYCLE_ACTIONS_PER_RUN).toBe(3);
  });
});

describe("crewCampaignsForLifecycle", () => {
  const c = (over: Partial<LifecycleCampaign> & { n: string }): LifecycleCampaign => ({
    title: over.n, slug: over.n, url: `https://testnet.cherr.io/en/campaigns/${over.n}`, contract: "0x00000000000000000000000000000000000000cc",
    state: "ending", demo: true, organization: { name: "Crew Org (testnet)" }, ...over,
  });
  const fakeFetch = (pages: LifecycleCampaign[][]) => (async (url: string | URL | Request) => {
    const page = Number(new URL(String(url)).searchParams.get("page") ?? "1");
    return new Response(JSON.stringify({ data: pages[page - 1] ?? [], pageCount: pages.length }), { status: 200 });
  }) as typeof fetch;

  it("keeps crew campaigns in non-live states only, over all pages", async () => {
    const got = await crewCampaignsForLifecycle(fakeFetch([
      [c({ n: "a" }), c({ n: "live", state: "live" }), c({ n: "person", demo: false }), c({ n: "plain-org", organization: { name: "Red Cross" } })],
      [c({ n: "b", state: "voting" }), c({ n: "done", state: "completed" }), c({ n: "off-site", url: "https://evil.example/x" })],
    ]));
    expect(got.map((x) => x.slug)).toEqual(["a", "b"]);
  });

  it("a person's campaign is never crew, even with a testnet-looking name or demo off", () => {
    expect(isCrewLifecycleCampaign({ demo: false, organization: { name: "X (testnet)" } })).toBe(false);
    expect(isCrewLifecycleCampaign({ demo: true, organization: { name: "X" } })).toBe(false);
    expect(isCrewLifecycleCampaign({ demo: true, organization: { name: "X (testnet)" } })).toBe(true);
  });

  it("fails loudly when the API errors", async () => {
    await expect(crewCampaignsForLifecycle((async () => new Response("", { status: 500 })) as typeof fetch)).rejects.toThrow("500");
  });
});
