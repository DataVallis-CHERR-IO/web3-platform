import { describe, expect, it } from "vitest";
import { registryFacts } from "@/lib/market-cap/facts";
import type { MarketCapProfile } from "@/lib/market-cap/profile";

// Register values come from public extracts and can be malformed: the profile must still render.
const profile = (registry: string, raw: Record<string, unknown>): MarketCapProfile => ({
  id: "x", name: "X", country: "US", causes: [], website: null, description: null, registered: false, claimable: false,
  registry, registryId: "123456789", score: "20.00", components: {}, raised: 0n, computedAt: new Date(), registryRecord: raw,
});

describe("registryFacts", () => {
  it("formats good values", () => {
    expect(registryFacts(profile("US_IRS", { city: "New York", state: "NY", taxPeriod: "202312", revenue: 1500 }), "en")).toEqual([
      ["ein", "123456789"], ["location", "New York, NY"], ["taxPeriod", "December 2023"], ["revenue", "$1,500"],
    ]);
  });

  it("drops malformed dates and non-numbers instead of throwing", () => {
    expect(registryFacts(profile("US_IRS", { taxPeriod: "201913", ruling: "000000", revenue: "n/a" }), "en")).toEqual([["ein", "123456789"]]);
    expect(registryFacts(profile("UK_CC", { status: "Registered", registeredOn: "2023-02-30", income: 5 }), "en")).toEqual([
      ["number", "123456789"], ["status", "Registered"], ["income", "£5"],
    ]);
  });
});
