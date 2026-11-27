/**
 * TASK-061g: donors push one crew campaign over the 10 % success threshold, so the crew
 * reaches the rest of the life cycle (payout mode, evidence, votes, ratings).
 */
import { describe, expect, it } from "vitest";
import { focusCampaign, isCrewCampaign, type ApiCampaign } from "../src/flows.js";

const c = (slug: string, raised: string | null, target: string, crew = true, demo = true): ApiCampaign => ({
  title: slug, slug, url: `https://testnet.cherr.io/en/campaigns/${slug}`, contract: "0x0000000000000000000000000000000000000001",
  state: "live", deadline: "2026-12-18T00:00:00.000Z", raisedUsdc: raised, target: { usdc: target }, demo,
  organization: { name: crew ? "Lantern Hill Reading Fund (testnet)" : "Real Shelter" },
});

describe("donors' focus (focusCampaign)", () => {
  it("recognises crew campaigns by the demo flag and the (testnet) organisation", () => {
    expect(isCrewCampaign(c("a", "0", "100000000"))).toBe(true);
    expect(isCrewCampaign(c("b", "0", "100000000", false))).toBe(false);
    expect(isCrewCampaign(c("c", "0", "100000000", true, false))).toBe(false); // a person's campaign is never "crew"
  });

  it("picks the crew campaign closest to 10 % that has not reached it", () => {
    const list = [
      c("far", "1000000", "117000000"), // 0.85 %
      c("close", "9000000", "117000000"), // 7.7 %
      c("done", "12000000", "117000000"), // 10.3 % — already over
      c("person", "11000000", "117000000", false), // not crew
      c("unknown", null, "117000000"),
    ];
    expect(focusCampaign(list)?.slug).toBe("close");
  });

  it("returns null when every crew campaign is over the threshold (donors pick at random then)", () => {
    expect(focusCampaign([c("done", "12000000", "117000000"), c("person", "0", "117000000", false)])).toBeNull();
    expect(focusCampaign([])).toBeNull();
  });
});
