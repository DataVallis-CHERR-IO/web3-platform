"use client";
import * as React from "react";
import { useWallets } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { getAddress, type Address, type EIP1193Provider } from "viem";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";
import type { SendCalls } from "@/lib/campaigns/donate-client";

// The wallets the signed-in user can act from on the campaign lifecycle panel
// (TASK-033b). A vote, refund or pool settlement must come from the address that
// donated (ADR-008), so the panel needs every connected address, not one choice:
// each external wallet, and the CHERR.IO smart account (one sponsored user
// operation, TASK-011c).

export interface Signer {
  account: Address;
  provider: (chainId: number) => Promise<EIP1193Provider>;
  sendCalls?: SendCalls;
}

export type SignerState =
  | { kind: "unavailable" }
  | { kind: "logged_out"; login: () => void }
  | { kind: "ready"; signers: Signer[] };

/** Test wallet for Playwright: honoured only when APP_ENV=local (never deployed). */
interface E2eWindow {
  __cherrioE2eWallet?: { address: string; provider: EIP1193Provider; sendCalls?: SendCalls };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

/** The E2E wallet when APP_ENV=local, else null (checked after mount). */
export function useE2eSigner(appEnv: string): Signer | null {
  const [signer, setSigner] = React.useState<Signer | null>(null);
  React.useEffect(() => {
    if (appEnv !== "local") return;
    const w = (window as unknown as E2eWindow).__cherrioE2eWallet;
    if (w) setSigner({ account: getAddress(w.address), provider: async () => w.provider, sendCalls: w.sendCalls });
  }, [appEnv]);
  return signer;
}

/** Every address the logged-in user can sign with through Privy. */
export function usePrivySigners(chainId: number): SignerState {
  const { isAuthenticated, isLoading, login } = useAppAuth();
  const { wallets, ready } = useWallets();
  const { client: smartClient, getClientForChain } = useSmartWallets();
  return React.useMemo<SignerState>(() => {
    if (!isAuthenticated) return isLoading ? { kind: "unavailable" } : { kind: "logged_out", login };
    if (!ready) return { kind: "unavailable" };
    const provider = (w: (typeof wallets)[number]) => async (id: number) => {
      await withTimeout(w.switchChain(id), 60_000).catch(() => undefined);
      return (await withTimeout(w.getEthereumProvider(), 20_000)) as EIP1193Provider;
    };
    const signers: Signer[] = wallets
      .filter((w) => w.walletClientType !== "privy")
      .map((w) => ({ account: getAddress(w.address), provider: provider(w) }));
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    const smartAddress = smartClient?.account?.address;
    if (embedded && smartClient && smartAddress) {
      signers.push({
        account: getAddress(smartAddress),
        provider: provider(embedded),
        sendCalls: async (calls) => {
          const client = (await getClientForChain({ id: chainId })) ?? smartClient;
          return client.sendTransaction({ calls });
        },
      });
    }
    return { kind: "ready", signers };
  }, [isAuthenticated, isLoading, login, ready, wallets, smartClient, getClientForChain, chainId]);
}

/** The signer for one donor address, if the user has it connected. */
export function signerFor(signers: Signer[], address: string): Signer | null {
  return signers.find((s) => s.account.toLowerCase() === address.toLowerCase()) ?? null;
}

/** For finalize / closeVote / release anyone may sign: the smart account first (sponsored), else any wallet. */
export function anySigner(signers: Signer[]): Signer | null {
  return signers.find((s) => s.sendCalls) ?? signers[0] ?? null;
}
