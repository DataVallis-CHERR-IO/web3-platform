import { describe, expect, it } from "vitest";
import { filterOptions } from "@/components/SearchableSelect";

const countries = [
  { value: "AT", label: "Austria" },
  { value: "HR", label: "Croatia" },
  { value: "CI", label: "Côte d’Ivoire" },
  { value: "SK", label: "Slovakia" },
  { value: "SI", label: "Slovenia" },
  { value: "PS", label: "Palestinian Territories" },
];

describe("filterOptions (country search)", () => {
  it("matches the start of the name first, then anywhere, ignoring case", () => {
    expect(filterOptions(countries, "slo").map((o) => o.value)).toEqual(["SK", "SI"]);
    expect(filterOptions(countries, "ia").map((o) => o.value)).toEqual(["AT", "HR", "SK", "SI", "PS"]);
  });
  it("ignores accents and matches the country code exactly", () => {
    expect(filterOptions(countries, "cote").map((o) => o.value)).toEqual(["CI"]);
    expect(filterOptions(countries, "si").map((o) => o.value)).toEqual(["SI"]);
  });
  it("an empty query returns everything; no match returns nothing", () => {
    expect(filterOptions(countries, "  ")).toHaveLength(6);
    expect(filterOptions(countries, "xyz")).toEqual([]);
  });
});
