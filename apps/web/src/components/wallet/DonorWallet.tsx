"use client";
import * as React from "react";
import { useWallets } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { getAddress, type Address, type EIP1193Provider } from "viem";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";
import type { SendCalls } from "@/lib/campaigns/donate-client";

// The wallet a person gives from (TASK-011b/c; shared since TASK-014b by the
// campaign donate panel and "Give to this pool"). An external wallet first (it
// holds the person's own USDC); otherwise the wallet created by CHERR.IO, whose
// ERC-4337 smart account sends its calls as one sponsored user operation.

/** A wallet that can give. */
export interface DonorWallet {
  /** The giver's address on chain (the smart account for a CHERR.IO wallet). */
  account: Address;
  /** EIP-1193 provider: reads, and signing on the two-transaction path. */
  provider: (chainId: number) => Promise<EIP1193Provider>;
  /** Smart account: sends calls as one sponsored user operation. */
  sendCalls?: SendCalls;
}

export type WalletState =
  | { kind: "unavailable" }
  | { kind: "preparing" }
  | { kind: "logged_out"; login: () => void }
  | { kind: "no_wallet" }
  | { kind: "ready"; wallet: DonorWallet };

/** Free test USDC on the test networks. */
export const CIRCLE_FAUCET = "https://faucet.circle.com/";

/** How long to wait for Privy's smart-account client before using the embedded wallet directly. */
const SMART_ACCOUNT_WAIT_MS = 8_000;

/** Test wallet for Playwright: honoured only when APP_ENV=local (never deployed). */
interface E2eWindow {
  __cherrioE2eWallet?: {
    address: string;
    provider: EIP1193Provider;
    /** Present → behaves like a smart account (one batched, sponsored call). */
    sendCalls?: SendCalls;
  };
}

/** Rejects with "timeout" when the wallet does not answer in time. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

export interface WithDonorWalletProps {
  chainId: number;
  appEnv: string;
  children: (wallet: WalletState) => React.ReactNode;
}

/** Renders `children` with the giver's wallet state (Privy when configured, else the E2E wallet on local). */
export function WithDonorWallet(props: WithDonorWalletProps) {
  const { isAvailable } = useAppAuth();
  const [e2e, setE2e] = React.useState<DonorWallet | null>(null);
  React.useEffect(() => {
    if (props.appEnv !== "local") return;
    const injected = (window as unknown as E2eWindow).__cherrioE2eWallet;
    if (injected) {
      setE2e({ account: getAddress(injected.address), provider: async () => injected.provider, sendCalls: injected.sendCalls });
    }
  }, [props.appEnv]);

  if (isAvailable) return <PrivyWallet {...props} />;
  return <>{props.children(e2e ? { kind: "ready", wallet: e2e } : { kind: "unavailable" })}</>;
}

function PrivyWallet(props: WithDonorWalletProps) {
  const { isAuthenticated, isLoading, login } = useAppAuth();
  const { wallets, ready } = useWallets();
  const { client: smartClient, getClientForChain } = useSmartWallets();
  const [smartWaitOver, setSmartWaitOver] = React.useState(false);
  React.useEffect(() => {
    const timer = setTimeout(() => setSmartWaitOver(true), SMART_ACCOUNT_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  let state: WalletState;
  if (!isAuthenticated) state = isLoading ? { kind: "unavailable" } : { kind: "logged_out", login };
  else {
    const external = wallets.find((w) => w.walletClientType !== "privy");
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    const chosen = external ?? embedded;
    const provider = (w: NonNullable<typeof chosen>) => async (chainId: number) => {
      await withTimeout(w.switchChain(chainId), 60_000).catch(() => undefined);
      return (await withTimeout(w.getEthereumProvider(), 20_000)) as EIP1193Provider;
    };
    const smartAddress = smartClient?.account?.address;
    if (!ready || !chosen) state = { kind: "no_wallet" };
    else if (!external && smartClient && smartAddress) {
      // CHERR.IO wallet → its smart account; reads through the embedded wallet.
      state = {
        kind: "ready",
        wallet: {
          account: getAddress(smartAddress),
          provider: provider(chosen),
          sendCalls: async (calls) => {
            const client = (await getClientForChain({ id: props.chainId })) ?? smartClient;
            return client.sendTransaction({ calls });
          },
        },
      };
    } else if (!external && !smartWaitOver) state = { kind: "preparing" };
    else state = { kind: "ready", wallet: { account: getAddress(chosen.address), provider: provider(chosen) } };
  }
  return <>{props.children(state)}</>;
}
