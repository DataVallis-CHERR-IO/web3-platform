"use client";
import * as React from "react";
import { createPublicClient, custom, http, type Address, type PublicClient } from "viem";
import type { AdminWallet, AdminWallets } from "@/components/admin/AdminWallets";
import { readRoles, type ConsoleChain } from "@/lib/contracts/console-client";

// The reader (/api/rpc or the E2E wallet) and which of the admin's connected
// wallets holds a PlatformConfig role. Used by Admin → Emergency Pool (Operator:
// sub-pools, proposals — TASK-046, TASK-014c) and Admin → Chain actions
// (Guardian: allocation decisions — TASK-014c-3).

export type ChainRole = "operator" | "guardian";

export interface RoleWalletState {
  reader: PublicClient | null;
  /** undefined while checking; null when no connected wallet holds the role. */
  holder: Address | null | undefined;
  wallet: AdminWallet | null;
  rolesFailed: boolean;
}

export function useRoleWallet(
  props: AdminWallets & { chainId: number; roles: ConsoleChain | null },
  role: ChainRole
): RoleWalletState {
  const [reader, setReader] = React.useState<PublicClient | null>(null);
  const [holder, setHolder] = React.useState<Address | null | undefined>(undefined);
  const [rolesFailed, setRolesFailed] = React.useState(false);
  const { chainId, roles, wallets, readProvider } = props;

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const transport = readProvider ? custom(await readProvider(chainId)) : http(`${window.location.origin}/api/rpc`, { retryCount: 0 });
      if (!cancelled) setReader(createPublicClient({ transport }));
    })();
    return () => { cancelled = true; };
  }, [readProvider, chainId]);

  React.useEffect(() => {
    if (!reader || wallets.length === 0) return;
    // Without the PlatformConfig address (unconfigured local env) the roles cannot be read: let the contract judge.
    if (!roles) {
      setHolder(wallets[0]!.account);
      return;
    }
    void Promise.all(wallets.map(async (w) => ({ account: w.account, has: (await readRoles(reader, roles, w.account))[role] })))
      .then((list) => { setHolder(list.find((r) => r.has)?.account ?? null); setRolesFailed(false); })
      .catch((e: unknown) => { console.error(`[admin] ${role} role`, e); setRolesFailed(true); });
  }, [reader, wallets, roles, role]);

  const wallet = holder ? wallets.find((w) => w.account === holder) ?? null : null;
  return { reader, holder, wallet, rolesFailed };
}
