"use client";
import type { Address, PublicClient } from "viem";
import type { AdminWallet, AdminWallets } from "@/components/admin/AdminWallets";
import type { ConsoleChain } from "@/lib/contracts/console-client";
import { useRoleWallet } from "@/components/admin/useRoleWallet";

// Admin → Emergency Pool (TASK-046, TASK-014c): which of the admin's wallets is
// the Operator. Shared by "Create sub-pools" and "Propose an allocation".

export interface OperatorState {
  reader: PublicClient | null;
  /** undefined while checking; null when no connected wallet is the Operator. */
  operator: Address | null | undefined;
  wallet: AdminWallet | null;
  rolesFailed: boolean;
}

export function useOperator(props: AdminWallets & { chainId: number; roles: ConsoleChain | null }): OperatorState {
  const { reader, holder, wallet, rolesFailed } = useRoleWallet(props, "operator");
  return { reader, operator: holder, wallet, rolesFailed };
}
