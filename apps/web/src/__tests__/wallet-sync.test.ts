import { describe, expect, it } from "vitest";
import { missingWalletAddresses, WALLET_SYNC_DELAYS_MS } from "@/lib/auth/wallet-sync";

const EOA = "0x243C0f479bA9Df34ac00253a4E5255Fc15c3262c";
const SMART = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

describe("missingWalletAddresses", () => {
  it("reports the embedded wallet that Privy created after the session was made", () => {
    expect(missingWalletAddresses([{ type: "email" }, { type: "wallet", address: EOA }], [])).toEqual([EOA.toLowerCase()]);
  });

  it("reports a linked smart wallet missing from the stored addresses", () => {
    const stored = [{ address: EOA.toLowerCase() }];
    expect(missingWalletAddresses([{ type: "wallet", address: EOA }, { type: "smart_wallet", address: SMART }], stored)).toEqual([
      SMART.toLowerCase(),
    ]);
  });

  it("also reports the smart-account client's address before Privy has linked it", () => {
    expect(missingWalletAddresses([{ type: "wallet", address: EOA }], [{ address: EOA.toLowerCase() }], SMART)).toEqual([
      SMART.toLowerCase(),
    ]);
  });

  it("is empty when everything is stored (case-insensitive) and ignores other account types", () => {
    const stored = [{ address: EOA }, { address: SMART.toLowerCase() }];
    expect(
      missingWalletAddresses([{ type: "wallet", address: EOA.toLowerCase() }, { type: "smart_wallet", address: SMART }, { type: "google_oauth" }], stored, SMART)
    ).toEqual([]);
    expect(missingWalletAddresses(undefined, [])).toEqual([]);
  });

  it("tries a few times, spaced out, then waits for the next change", () => {
    expect(WALLET_SYNC_DELAYS_MS[0]).toBe(0);
    expect(WALLET_SYNC_DELAYS_MS.length).toBeGreaterThanOrEqual(4);
    expect([...WALLET_SYNC_DELAYS_MS].every((d, i, all) => i === 0 || d > all[i - 1]!)).toBe(true);
  });
});
