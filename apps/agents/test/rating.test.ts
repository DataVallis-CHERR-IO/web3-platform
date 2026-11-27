import { describe, expect, it } from "vitest";
import {
  MAX_RATINGS_PER_RUN, RATEABLE_PUBLIC_STATES, commentFor, decideRating, finishedCrewCampaigns, starLabel, starsFor, type RatingJson,
} from "../src/rating.js";
import { checkTypedData } from "../src/policy.js";

// TASK-061g: who rates what, with how many stars. No network: fetch is a fake.

const crew = { demo: true, organization: { name: "Kind Hearts (testnet)" } };
const open: RatingJson = { status: "open", rating: null };
const camp = (state: string | null, extra: object = {}) => ({ state, ...crew, ...extra });

describe("starsFor / commentFor / starLabel", () => {
  it("5 for completed, 3 for failed or rejected, nothing for the rest", () => {
    expect(starsFor("completed")).toBe(5);
    expect(starsFor("failed")).toBe(3);
    expect(starsFor("rejected")).toBe(3);
    for (const s of ["live", "ending", "succeeded", "voting", null]) expect(starsFor(s)).toBeNull();
  });
  it("comment names the agent and the stars, and says it is a test", () => {
    expect(commentFor("donor-1", 5)).toBe("Testnet agent donor-1: 5 stars — test rating, not a real review.");
  });
  it("radio label follows the app's plural", () => {
    expect(starLabel(1)).toBe("1 star");
    expect(starLabel(4)).toBe("4 stars");
  });
  it("the cap is two ratings per member per run", () => expect(MAX_RATINGS_PER_RUN).toBe(2));
});

describe("decideRating", () => {
  it("rates a finished crew campaign the API calls open, with the state's stars", () => {
    expect(decideRating(camp("completed"), open)).toEqual({ rate: true, stars: 5 });
    expect(decideRating(camp("failed"), open)).toEqual({ rate: true, stars: 3 });
  });
  it("never rates a campaign that is not the crew's", () => {
    expect(decideRating(camp("completed", { demo: false }), open).rate).toBe(false);
    expect(decideRating(camp("completed", { organization: { name: "Real Charity" } }), open).rate).toBe(false);
  });
  it("does not rate a campaign that is not finished", () => {
    expect(decideRating(camp("voting"), open)).toMatchObject({ rate: false });
  });
  it("skips when the API says this member may not rate (not a donor, window closed, own)", () => {
    for (const status of ["not_donor", "window_closed", "own", "not_finished", "individual"]) {
      expect(decideRating(camp("completed"), { status, rating: null }).rate).toBe(false);
    }
  });
  it("rates once: an existing rating is left alone", () => {
    expect(decideRating(camp("completed"), { status: "open", rating: { stars: 4, comment: null } })).toEqual({ rate: false, reason: "already rated" });
  });
});

describe("finishedCrewCampaigns", () => {
  it("lists only crew campaigns in a rateable state", async () => {
    const mk = (state: string, org: string, demo = true) => ({
      id: `id-${state}-${org}`, title: "t", slug: "s", url: "https://testnet.cherr.io/en/campaigns/s", contract: "0xabc", state, demo, organization: { name: org },
    });
    const fake = (async () => new Response(JSON.stringify({
      data: [mk("completed", "A (testnet)"), mk("live", "A (testnet)"), mk("failed", "B (testnet)"), mk("completed", "Real"), mk("rejected", "C (testnet)", false)],
      pageCount: 1,
    }))) as typeof fetch;
    const got = await finishedCrewCampaigns(fake);
    expect(got.map((c) => c.state)).toEqual(["completed", "failed"]);
    expect(RATEABLE_PUBLIC_STATES).toEqual(["completed", "failed", "rejected"]);
  });
});

describe("signer policy", () => {
  it("allows only the app's Rating message (unchanged)", () => {
    expect(checkTypedData({ primaryType: "Permit", domain: {}, types: {} }, 80002).ok).toBe(false);
  });
});
