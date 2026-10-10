"use client";
import * as React from "react";
import { createPublicClient, custom, http, type Address, type PublicClient } from "viem";
import type { AdminWallet, AdminWallets } from "@/components/admin/AdminWallets";
import { readRoles, type ConsoleChain } from "@/lib/contracts/console-client";

// Admin → Emergency Pool (TASK-046, TASK-014c): the reader (/api/rpc or the E2E
// wallet) and which of the admin's wallets holds the Operator role. Shared by
// "Create sub-pools" and "Propose an allocation".

export interface OperatorState {
  reader: PublicClient | null;
  /** undefined while checking; null when no connected wallet is the Operator. */
  operator: Address | null | undefined;
  wallet: AdminWallet | null;
  rolesFailed: boolean;
}

export function useOperator(props: AdminWallets & { chainId: number; roles: ConsoleChain | null }): OperatorState {
  const [reader, setReader] = React.useState<PublicClient | null>(null);
  const [operator, setOperator] = React.useState<Address | null | undefined>(undefined);
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
    if (!roles) {
      setOperator(wallets[0]!.account);
      return;
    }
    void Promise.all(wallets.map(async (w) => ({ account: w.account, operator: (await readRoles(reader, roles, w.account)).operator })))
      .then((list) => { setOperator(list.find((r) => r.operator)?.account ?? null); setRolesFailed(false); })
      .catch((e: unknown) => { console.error("[pool] roles", e); setRolesFailed(true); });
  }, [reader, wallets, roles]);

  const wallet = operator ? wallets.find((w) => w.account === operator) ?? null : null;
  return { reader, operator, wallet, rolesFailed };
}
