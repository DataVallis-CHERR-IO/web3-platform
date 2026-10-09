import { describe, it, expect } from "vitest";
import { campaignDraftSchema, slugify } from "../src/campaigns.js";

const valid = {
  title: "A new roof for the animal shelter",
  story: "The roof of our shelter leaks.\n\nWith your help we replace it before winter and keep forty dogs dry.",
  cause: "animals",
  country: "SI",
  goalCurrency: "EUR",
  goal: 12_000,
  durationDays: 30,
};
const ok = (override: Record<string, unknown>) => campaignDraftSchema.safeParse({ ...valid, ...override }).success;

describe("campaign draft schema", () => {
  it("accepts a valid draft and trims title and story", () => {
    const parsed = campaignDraftSchema.parse({ ...valid, title: `  ${valid.title}  ` });
    expect(parsed.title).toBe(valid.title);
  });

  it("title 5–120 and story 50–10,000 characters", () => {
    expect(ok({ title: "Roof" })).toBe(false);
    expect(ok({ title: "x".repeat(121) })).toBe(false);
    expect(ok({ story: "Too short." })).toBe(false);
    expect(ok({ story: "x".repeat(10_001) })).toBe(false);
    expect(ok({ story: "x".repeat(10_000) })).toBe(true);
  });

  it("goal currency: EUR or USD only (ADR-060)", () => {
    expect(ok({ goalCurrency: "USD" })).toBe(true);
    expect(ok({ goalCurrency: "GBP" })).toBe(false);
    expect(ok({ goalCurrency: "USDC" })).toBe(false);
    expect(ok({ goalCurrency: undefined })).toBe(false);
  });

  it("goal: whole units from 100 to 1,000,000", () => {
    expect(ok({ goal: 99 })).toBe(false);
    expect(ok({ goal: 100 })).toBe(true);
    expect(ok({ goal: 1_000_000 })).toBe(true);
    expect(ok({ goal: 1_000_001 })).toBe(false);
    expect(ok({ goal: 150.5 })).toBe(false);
    expect(ok({ goal: "1000" })).toBe(false); // a number, never a string
  });

  it("duration 7–90 days, cause from the fixed list, ISO country", () => {
    expect(ok({ durationDays: 6 })).toBe(false);
    expect(ok({ durationDays: 7 })).toBe(true);
    expect(ok({ durationDays: 90 })).toBe(true);
    expect(ok({ durationDays: 91 })).toBe(false);
    expect(ok({ cause: "crypto" })).toBe(false);
    expect(ok({ country: "XX" })).toBe(false);
    expect(ok({ country: "IR" })).toBe(false); // ADR-054: sanctioned
    expect(ok({ country: "UA" })).toBe(true);
  });
});

describe("slugify", () => {
  it("makes lowercase ASCII slugs, removes accents and punctuation", () => {
    expect(slugify("A new roof for the animal shelter")).toBe("a-new-roof-for-the-animal-shelter");
    expect(slugify("  Streha za zavetišče — Črnuče, 2026!  ")).toBe("streha-za-zavetisce-crnuce-2026");
    expect(slugify("Hilfe für Kinder & Jugend")).toBe("hilfe-fur-kinder-jugend");
  });

  it("is at most 80 characters, never ends with a dash and is never empty", () => {
    const long = slugify(`${"word ".repeat(30)}`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("-")).toBe(false);
    expect(slugify("!!! ???")).toBe("campaign");
    expect(slugify("日本語のタイトル")).toBe("campaign");
  });
});
