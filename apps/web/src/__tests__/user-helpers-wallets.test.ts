import { describe, expect, it } from "vitest";
import { extractWalletsFromPrivyUser } from "@/lib/auth/user-helpers";

// Wallet kinds from the server-side Privy user record (TASK-011c adds SMART_ACCOUNT).
const EOA = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const SMART = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const EXTERNAL = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";

describe("extractWalletsFromPrivyUser", () => {
  it("stores the smart wallet as SMART_ACCOUNT next to its embedded signer", () => {
    const wallets = extractWalletsFromPrivyUser({
      linkedAccounts: [
        { type: "email" },
        { type: "wallet", address: EOA, walletClientType: "privy", connectorType: "embedded" },
        { type: "smart_wallet", address: SMART },
      ],
    });
    expect(wallets).toEqual([
      { address: EOA.toLowerCase(), kind: "EMBEDDED" },
      { address: SMART.toLowerCase(), kind: "SMART_ACCOUNT" },
    ]);
  });

  it("keeps external wallets EXTERNAL and ignores malformed addresses", () => {
    const wallets = extractWalletsFromPrivyUser({
      linkedAccounts: [
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask", connectorType: "injected" },
        { type: "smart_wallet", address: "0x123" },
      ],
    });
    expect(wallets).toEqual([{ address: EXTERNAL.toLowerCase(), kind: "EXTERNAL" }]);
  });
});
