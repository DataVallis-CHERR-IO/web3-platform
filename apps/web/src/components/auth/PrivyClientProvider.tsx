"use client";
import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { PrivyProvider, usePrivy, useLinkAccount } from "@privy-io/react-auth";
import type { AppEnv } from "@cherrio/shared";
import { useTranslations } from "next-intl";
import { toast } from "@cherrio/ui";

export interface AppUser {
  id: string;
  displayName: string;
  email: string | null;
  anonymousDonations: boolean;
  locale: string;
  roles: string[];
  addresses: Array<{
    id: string;
    address: string;
    kind: "EMBEDDED" | "SMART_ACCOUNT" | "EXTERNAL";
    isPrimary: boolean;
  }>;
}

export interface AppAuthContextValue {
  isAvailable: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AppUser | null;
  login: () => void;
  logout: () => Promise<void>;
  syncWallets: () => Promise<void>;
  refreshUser: () => Promise<void>;
  linkWallet: () => void;
  unlinkWallet: (address: string) => Promise<void>;
}

const AppAuthContext = createContext<AppAuthContextValue>({
  isAvailable: false,
  isAuthenticated: false,
  isLoading: false,
  user: null,
  login: () => {},
  logout: async () => {},
  syncWallets: async () => {},
  refreshUser: async () => {},
  linkWallet: () => {},
  unlinkWallet: async () => {},
});

export function useAppAuth() {
  return useContext(AppAuthContext);
}

const amoyChain = {
  id: 80002,
  name: "Polygon Amoy",
  network: "polygon-amoy",
  nativeCurrency: {
    name: "POL",
    symbol: "POL",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: ["https://rpc-amoy.polygon.technology"] },
  },
  blockExplorers: {
    default: { name: "PolygonScan", url: "https://amoy.polygonscan.com" },
  },
};

const polygonChain = {
  id: 137,
  name: "Polygon",
  network: "polygon",
  nativeCurrency: {
    name: "POL",
    symbol: "POL",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: ["https://polygon-rpc.com"] },
  },
  blockExplorers: {
    default: { name: "PolygonScan", url: "https://polygonscan.com" },
  },
};

/** Paths that need a session; after logout the browser goes to the locale's home page. */
const PROTECTED_PATH = /^\/([a-z]{2})\/(account|admin|organizations\/new)(\/|$)/;

export function protectedPathHome(pathname: string): string | null {
  const match = PROTECTED_PATH.exec(pathname);
  return match ? `/${match[1]}` : null;
}

function leaveProtectedPage() {
  if (typeof window === "undefined") return;
  const home = protectedPathHome(window.location.pathname);
  if (home) window.location.assign(home);
}

function AuthSyncInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const {
    ready,
    authenticated,
    user: privyUser,
    login: privyLogin,
    logout: privyLogout,
    unlinkWallet: privyUnlinkWallet,
    getAccessToken,
  } = usePrivy();

  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [syncing, setSyncing] = useState<boolean>(true);
  const hadSessionRef = useRef<boolean>(false);
  const lastSyncedUserIdRef = useRef<string | null>(null);
  const tAuth = useTranslations("ui.auth");

  const privyUserId = privyUser?.id;

  const refreshUser = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/user");
      if (res.ok) {
        const data = await res.json();
        setAppUser(data.user);
      } else if (res.status === 401) {
        setAppUser(null);
      }
    } catch {
      // silent
    }
  }, []);

  const syncWallets = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/wallets/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        await refreshUser();
      } else if (res.status === 409) {
        toast.error(tAuth("walletConflictDesc"));
      }
    } catch {
      // silent
    }
  }, [refreshUser, tAuth]);

  // Handle wallet link callback explicitly
  const { linkWallet: privyLinkWallet } = useLinkAccount({
    onSuccess: async () => {
      await syncWallets();
    },
  });

  // Synchronise Privy session with app backend session
  // Runs only on authentication state changes (ready, authenticated, privyUserId)
  useEffect(() => {
    let isMounted = true;

    async function handleAuthChange() {
      if (!ready) return;

      if (authenticated && privyUserId) {
        if (lastSyncedUserIdRef.current === privyUserId && hadSessionRef.current) {
          // Already synced for this user session
          return;
        }

        setSyncing(true);
        try {
          const token = await getAccessToken();
          if (!token) {
            if (isMounted) setSyncing(false);
            return;
          }

          const res = await fetch("/api/auth/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessToken: token }),
          });

          if (res.ok) {
            const data = await res.json();
            if (isMounted) {
              setAppUser(data.user);
              hadSessionRef.current = true;
              lastSyncedUserIdRef.current = privyUserId;
            }
          } else if (res.status === 409) {
            toast.error(tAuth("walletConflictDesc"));
            await privyLogout();
            if (isMounted) {
              setAppUser(null);
              hadSessionRef.current = false;
              lastSyncedUserIdRef.current = null;
            }
          } else {
            // Server refused the session (401/403/429/500). Do not leave Privy
            // logged in while the app is logged out — the Log in button would
            // then be a no-op ("user is already logged in").
            toast.error(tAuth("loginFailedDesc"));
            await privyLogout();
            if (isMounted) {
              setAppUser(null);
              hadSessionRef.current = false;
              lastSyncedUserIdRef.current = null;
            }
          }
        } catch {
          toast.error(tAuth("loginFailedDesc"));
          try {
            await privyLogout();
          } catch {
            // ignore — best effort
          }
          if (isMounted) {
            setAppUser(null);
            hadSessionRef.current = false;
            lastSyncedUserIdRef.current = null;
          }
        } finally {
          if (isMounted) setSyncing(false);
        }
      } else {
        // Logged out: cleanly terminate server session if previously authenticated
        lastSyncedUserIdRef.current = null;
        if (hadSessionRef.current) {
          hadSessionRef.current = false;
          try {
            await fetch("/api/auth/session", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
            });
          } catch {
            // silent
          }
        }
        if (isMounted) {
          setAppUser(null);
          setSyncing(false);
        }
      }
    }

    handleAuthChange();

    return () => {
      isMounted = false;
    };
  }, [ready, authenticated, privyUserId, getAccessToken, privyLogout, tAuth]);

  const logout = useCallback(async () => {
    setSyncing(true);
    hadSessionRef.current = false;
    lastSyncedUserIdRef.current = null;
    try {
      await fetch("/api/auth/session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      await privyLogout();
      setAppUser(null);
      // Pages behind the login (account, admin, organisation form) must not stay open.
      leaveProtectedPage();
    } finally {
      setSyncing(false);
    }
  }, [privyLogout]);

  // If Privy is logged in but the app has no session (stale state from an
  // earlier failed login), log Privy out first so the modal can open again.
  const login = useCallback(async () => {
    if (authenticated && !appUser) {
      try {
        await privyLogout();
      } catch {
        // ignore — best effort
      }
    }
    privyLogin();
  }, [authenticated, appUser, privyLogout, privyLogin]);

  const handleLinkWallet = useCallback(() => {
    privyLinkWallet();
  }, [privyLinkWallet]);

  const handleUnlinkWallet = useCallback(
    async (address: string) => {
      try {
        await privyUnlinkWallet(address);
        await syncWallets();
      } catch (err) {
        console.error("Failed to unlink wallet:", err);
      }
    },
    [privyUnlinkWallet, syncWallets]
  );

  const contextValue: AppAuthContextValue = {
    isAvailable: true,
    isAuthenticated: Boolean(authenticated && appUser),
    isLoading: !ready || syncing,
    user: appUser,
    login,
    logout,
    syncWallets,
    refreshUser,
    linkWallet: handleLinkWallet,
    unlinkWallet: handleUnlinkWallet,
  };

  return (
    <AppAuthContext.Provider value={contextValue}>
      {children}
    </AppAuthContext.Provider>
  );
}

export function PrivyClientProvider({
  privyAppId,
  appEnv = "local",
  children,
}: {
  privyAppId?: string;
  appEnv?: AppEnv;
  children: React.ReactNode;
}) {
  if (!privyAppId) {
    // Unconfigured fallback (CI / local tests without credentials)
    const fallbackValue: AppAuthContextValue = {
      isAvailable: false,
      isAuthenticated: false,
      isLoading: false,
      user: null,
      login: () => {},
      logout: async () => {},
      syncWallets: async () => {},
      refreshUser: async () => {},
      linkWallet: () => {},
      unlinkWallet: async () => {},
    };

    return (
      <AppAuthContext.Provider value={fallbackValue}>
        {children}
      </AppAuthContext.Provider>
    );
  }

  const defaultChain = appEnv === "prod" ? polygonChain : amoyChain;

  const cherryAccent = "#" + "f73b6b"; // cherry-500 brand token

  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        appearance: {
          accentColor: cherryAccent as `#${string}`,
          logo: "/brand/cherrio-wordmark-ink.svg",
          walletList: [
            "metamask",
            "detected_wallets",
            "coinbase_wallet",
            "rainbow",
            "wallet_connect",
          ],
        },
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
        },
        defaultChain,
        supportedChains: [defaultChain],
      }}
    >
      <AuthSyncInner>{children}</AuthSyncInner>
    </PrivyProvider>
  );
}
