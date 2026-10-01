/**
 * Auth user utility functions.
 * Rule: Default display_name must not reveal personal data (e.g. Supporter 7KQ2).
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Generates a default pseudonymous display name: "Supporter" + 4 random alphanumeric chars.
 * Never uses email local-part or wallet address.
 */
export function generateDefaultDisplayName(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return `Supporter ${code}`;
}

export interface ExtractedWallet {
  address: string;
  kind: "EMBEDDED" | "EXTERNAL";
}

/**
 * Normalises and extracts wallet accounts from a Privy user record.
 */
export function extractWalletsFromPrivyUser(user: {
  linkedAccounts?: Array<{
    type?: string;
    address?: string;
    walletClientType?: string;
    connectorType?: string;
  }>;
  wallet?: {
    address?: string;
    walletClientType?: string;
    connectorType?: string;
  };
}): ExtractedWallet[] {
  const wallets: ExtractedWallet[] = [];
  const seen = new Set<string>();

  const accounts = user.linkedAccounts ?? [];
  for (const acc of accounts) {
    if (acc.type === "wallet" && acc.address) {
      const address = acc.address.toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(address) && !seen.has(address)) {
        seen.add(address);
        const isEmbedded =
          acc.walletClientType === "privy" ||
          acc.connectorType === "embedded";
        wallets.push({
          address,
          kind: isEmbedded ? "EMBEDDED" : "EXTERNAL",
        });
      }
    }
  }

  if (user.wallet?.address) {
    const address = user.wallet.address.toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(address) && !seen.has(address)) {
      seen.add(address);
      const isEmbedded =
        user.wallet.walletClientType === "privy" ||
        user.wallet.connectorType === "embedded";
      wallets.push({
        address,
        kind: isEmbedded ? "EMBEDDED" : "EXTERNAL",
      });
    }
  }

  return wallets;
}

/**
 * Extracts verified email from Privy user object if present.
 */
export function extractEmailFromPrivyUser(user: {
  email?: { address?: string | null } | null;
  google?: { email?: string | null } | null;
  linkedAccounts?: Array<object>;
}): string | null {
  if (user.email?.address) return user.email.address;
  if (user.google?.email) return user.google.email;
  for (const acc of (user.linkedAccounts ?? []) as Array<{ type?: string; address?: string; email?: string }>) {
    if (acc.type === "email" && typeof acc.address === "string") return acc.address;
    if (acc.type === "google_oauth" && typeof acc.email === "string") return acc.email;
  }
  return null;
}
