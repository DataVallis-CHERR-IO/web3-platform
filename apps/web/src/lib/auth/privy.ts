import { PrivyClient } from "@privy-io/server-auth";

let privyClientInstance: PrivyClient | null = null;

export function getPrivyClient(): PrivyClient {
  if (privyClientInstance) return privyClientInstance;

  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;

  if (!appId || !appSecret) {
    const appEnv = process.env.APP_ENV ?? "local";
    if (appEnv !== "local") {
      throw new Error(`[Auth] Missing PRIVY_APP_ID or PRIVY_APP_SECRET in ${appEnv} environment`);
    }
    // In local dev without credentials, create dummy client or throw helpful message
    privyClientInstance = new PrivyClient("dummy_app_id", "dummy_app_secret");
    return privyClientInstance;
  }

  privyClientInstance = new PrivyClient(appId, appSecret);
  return privyClientInstance;
}

/** Set custom Privy client (used for integration tests) */
export function setPrivyClientForTesting(client: PrivyClient | null): void {
  privyClientInstance = client;
}
