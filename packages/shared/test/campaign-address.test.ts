import { describe, expect, it } from "vitest";
import { predictCampaignAddress } from "../src/campaign-address.js";

// Vectors computed independently of viem (Python, pycryptodome keccak, the
// EIP-1167 init code of OpenZeppelin v5 Clones) for the amoy-dev deployment.
const FACTORY = "0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00";
const IMPLEMENTATION = "0x6F6A9F54cC48a13bC5bFc127d16D874D07ccEA8F";

describe("predictCampaignAddress (CREATE2 of an EIP-1167 clone)", () => {
  it.each([
    ["0x" + "00".repeat(32), "0x1b9F2891FAc923361C77f2Fbc95C19B3e45e15DE"],
    ["0x" + "11".repeat(32), "0xB47469d2CcC104d2e4fd86A3147F2d6E84217306"],
    ["0xc0ffee" + "00".repeat(29), "0xfFCa099712d91Ba9Ebcd470D042b1CA676909b0E"],
  ] as const)("salt %s → %s", (salt, expected) => {
    expect(predictCampaignAddress(FACTORY, IMPLEMENTATION, salt as `0x${string}`)).toBe(expected);
  });

  it("does not depend on the case of the inputs", () => {
    expect(
      predictCampaignAddress(FACTORY.toLowerCase() as `0x${string}`, IMPLEMENTATION.toLowerCase() as `0x${string}`, `0x${"11".repeat(32)}`)
    ).toBe("0xB47469d2CcC104d2e4fd86A3147F2d6E84217306");
  });

  it("refuses an offchain id that is not 32 bytes", () => {
    expect(() => predictCampaignAddress(FACTORY, IMPLEMENTATION, "0x1234")).toThrow(/32 bytes/);
  });
});
