import { describe, it, expect } from "vitest";
import {
  ALLOWED_COUNTRY_CODES,
  COUNTRY_CODES,
  isSanctionedCountry,
  SANCTIONED_COUNTRY_CODES,
  kybDocumentsComplete,
  organizationApplicationSchema,
} from "../src/organizations.js";

const valid = {
  name: "  Test Shelter  ",
  legalName: "Test Shelter Society",
  country: "SI",
  registry: "SI_AJPES",
  registryId: " 1234567000 ",
  website: "https://example.org",
  description: "A generated organisation for tests.",
  causes: ["animals", "community"],
  payoutAddress: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", // EIP-55 test vector
  fileIds: ["0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c"],
};
const parse = (override: Record<string, unknown>) => organizationApplicationSchema.safeParse({ ...valid, ...override });

describe("organisation application schema", () => {
  it("accepts a valid application, trims text and lowercases the payout address", () => {
    const result = organizationApplicationSchema.parse(valid);
    expect(result.name).toBe("Test Shelter");
    expect(result.registryId).toBe("1234567000");
    expect(result.payoutAddress).toBe("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
  });

  it("payout address: lowercase is accepted, a wrong checksum or a non-address is refused", () => {
    expect(parse({ payoutAddress: valid.payoutAddress.toLowerCase() }).success).toBe(true);
    expect(parse({ payoutAddress: "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }).success).toBe(false);
    expect(parse({ payoutAddress: "0x1234" }).success).toBe(false);
    expect(parse({ payoutAddress: "" }).success).toBe(false);
  });

  it("registry number: required unless NONE, empty for NONE, at most 64 characters", () => {
    expect(parse({ registryId: "" }).success).toBe(false);
    expect(parse({ registryId: "x".repeat(65) }).success).toBe(false);
    expect(parse({ registry: "NONE", registryId: "" }).success).toBe(true);
    expect(parse({ registry: "NONE" }).success).toBe(false); // a number without a registry
    expect(parse({ registry: "DE_HRB" }).success).toBe(false);
  });

  it("website is optional and https only", () => {
    expect(parse({ website: "" }).success).toBe(true);
    expect(parse({ website: "http://example.org" }).success).toBe(false);
    expect(parse({ website: "javascript:alert(1)" }).success).toBe(false);
  });

  it("country, description, causes and file ids are checked", () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(parse({ country: "XX" }).success).toBe(false);
    // ADR-054: no organisation from a sanctioned country.
    for (const code of SANCTIONED_COUNTRY_CODES) expect(parse({ country: code }).success, code).toBe(false);
    expect(parse({ country: "UA" }).success).toBe(true);
    expect(parse({ description: "x".repeat(1001) }).success).toBe(false);
    expect(parse({ causes: [] }).success).toBe(false);
    expect(parse({ causes: ["animals", "animals"] }).success).toBe(false);
    expect(parse({ causes: ["crypto"] }).success).toBe(false);
    expect(parse({ fileIds: [valid.fileIds[0]] }).success).toBe(false);
    expect(parse({ fileIds: [valid.fileIds[0], valid.fileIds[0]] }).success).toBe(false);
    expect(parse({ fileIds: ["not-a-uuid", valid.fileIds[1]] }).success).toBe(false);
  });

  it("documents: extract and authorisation exactly once, statute at most once, other at most twice", () => {
    const required = ["KYB_REGISTRATION_EXTRACT", "KYB_AUTHORISATION"];
    expect(kybDocumentsComplete(required)).toBe(true);
    expect(kybDocumentsComplete([...required, "KYB_STATUTE", "KYB_OTHER", "KYB_OTHER"])).toBe(true);
    expect(kybDocumentsComplete(["KYB_REGISTRATION_EXTRACT", "KYB_STATUTE"])).toBe(false);
    expect(kybDocumentsComplete([...required, "KYB_AUTHORISATION"])).toBe(false);
    expect(kybDocumentsComplete([...required, "KYB_OTHER", "KYB_OTHER", "KYB_OTHER"])).toBe(false);
    expect(kybDocumentsComplete([...required, "KYC_PASSPORT"])).toBe(false);
  });
});

describe("sanctioned countries (ADR-054)", () => {
  it("six countries under comprehensive sanctions; every other ISO code stays allowed", () => {
    expect([...SANCTIONED_COUNTRY_CODES].sort()).toEqual(["BY", "CU", "IR", "KP", "RU", "SY"]);
    expect(SANCTIONED_COUNTRY_CODES.every((c) => COUNTRY_CODES.includes(c))).toBe(true);
    expect(ALLOWED_COUNTRY_CODES).toHaveLength(COUNTRY_CODES.length - 6);
    expect(isSanctionedCountry("ru")).toBe(true);
    expect(isSanctionedCountry("SI")).toBe(false);
  });
});
