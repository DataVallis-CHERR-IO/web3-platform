"use client";
import * as React from "react";
import { useWallets } from "@privy-io/react-auth";
import { getAddress, type Address, type EIP1193Provider } from "viem";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";

// The admin's own signing wallets (ADR-035): Admin → Contracts (TASK-034b) and
// the chain actions on the admin campaign page (TASK-033d). External wallets
// only — the Safe/operator/Guardian keys live in MetaMask or a hardware wallet,
// never in a Privy embedded wallet. Playwright injects a test wallet, honoured
// only when APP_ENV=local (never deployed).

export interface AdminWallet {
  account: Address;
  provider: (chainId: number) => Promise<EIP1193Provider>;
}

export interface AdminWallets {
  wallets: AdminWallet[];
  walletsReady: boolean;
  /** E2E only: reads go through the test wallet instead of `/api/rpc`. */
  readProvider?: AdminWallet["provider"];
}

interface E2eWindow {
  __cherrioE2eWallet?: { address: string; provider: EIP1193Provider };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

/** Renders `children` with the admin's wallets; `loading` until it knows which source applies. */
export function AdminWalletGate(props: { appEnv: string; loading: React.ReactNode; children: (w: AdminWallets) => React.ReactNode }) {
  const { isAvailable } = useAppAuth();
  const [e2e, setE2e] = React.useState<AdminWallet | null>(null);
  const [checked, setChecked] = React.useState(props.appEnv !== "local");
  React.useEffect(() => {
    if (props.appEnv !== "local") return;
    const injected = (window as unknown as E2eWindow).__cherrioE2eWallet;
    if (injected) setE2e({ account: getAddress(injected.address), provider: async () => injected.provider });
    setChecked(true);
  }, [props.appEnv]);
  if (!checked) return <>{props.loading}</>;
  if (e2e) return <>{props.children({ wallets: [e2e], walletsReady: true, readProvider: e2e.provider })}</>;
  if (isAvailable) return <PrivyWallets>{props.children}</PrivyWallets>;
  return <>{props.children({ wallets: [], walletsReady: true })}</>;
}

function PrivyWallets(props: { children: (w: AdminWallets) => React.ReactNode }) {
  const { wallets, ready } = useWallets();
  const external = React.useMemo(
    () =>
      wallets
        .filter((w) => w.walletClientType !== "privy")
        .map<AdminWallet>((w) => ({
          account: getAddress(w.address),
          provider: async (chainId) => {
            await withTimeout(w.switchChain(chainId), 60_000).catch(() => undefined);
            return (await withTimeout(w.getEthereumProvider(), 20_000)) as EIP1193Provider;
          },
        })),
    [wallets]
  );
  return <>{props.children({ wallets: external, walletsReady: ready })}</>;
}
