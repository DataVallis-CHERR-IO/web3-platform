// Client-side trigger for POST /api/auth/wallets/sync. Privy creates the
// embedded wallet a few seconds after the first login, and links the smart
// account a moment later still — after our session already exists. The browser
// compares what Privy reports with the addresses our server stored and asks the
// server to re-sync when one is missing. The server never trusts these
// addresses: it reads the Privy user record itself (`extractWalletsFromPrivyUser`).

/** A Privy linked account as the React SDK reports it (only the fields we read). */
export interface PrivyLinkedAccountLike {
  type?: string;
  address?: string;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * Wallet and smart-wallet addresses Privy reports (plus the smart-account
 * client's address, if known) that are not yet among the stored addresses.
 * Lower-case, sorted, without duplicates.
 */
export function missingWalletAddresses(
  linkedAccounts: readonly PrivyLinkedAccountLike[] | undefined,
  stored: readonly { address: string }[],
  smartClientAddress?: string | null
): string[] {
  const have = new Set(stored.map((a) => a.address.toLowerCase()));
  const reported = new Set<string>();
  for (const acc of linkedAccounts ?? []) {
    if ((acc.type === "wallet" || acc.type === "smart_wallet") && acc.address) reported.add(acc.address.toLowerCase());
  }
  if (smartClientAddress) reported.add(smartClientAddress.toLowerCase());
  return [...reported].filter((a) => ADDRESS.test(a) && !have.has(a)).sort();
}

/**
 * Delays (ms) between sync tries for one set of missing addresses. Privy's
 * server record can lag its client by a few seconds; after the last try we wait
 * for the next change in what Privy reports.
 */
export const WALLET_SYNC_DELAYS_MS = [0, 2_000, 5_000, 10_000, 20_000] as const;
