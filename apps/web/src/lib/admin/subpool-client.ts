import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, custom,
  type Address, type EIP1193Provider, type Hash,
} from "viem";
import { EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { polygonFeesFrom } from "@/lib/campaigns/publish-client";
import { LifecycleError, toLifecycleFailure, type LifecycleFailure, type LifecycleReader } from "@/lib/campaigns/lifecycle-client";

// Browser side of Admin → Emergency Pool (TASK-046): `createSubPool(poolId)` on
// the EmergencyPool, signed by an Operator's external wallet (MetaMask). Same
// shape as the lifecycle actions: simulated first through the reader (the
// same-origin `/api/rpc` client), so a refusal never reaches the wallet and has
// a name; the wallet only answers eth_chainId and signs.

/** EmergencyPool.sol custom errors that `createSubPool` can raise. */
const REVERTS: Record<string, LifecycleFailure> = {
  NotOperator: "not_operator",
  PoolAlreadyExists: "already_done",
};

export function toSubpoolFailure(error: unknown): LifecycleFailure {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const mapped = REVERTS[revert.data?.errorName ?? ""];
      if (mapped) return mapped;
    }
  }
  return toLifecycleFailure(error);
}

export async function sendCreateSubPool(
  provider: EIP1193Provider,
  account: Address,
  call: { chainId: number; pool: Address; poolId: number },
  options: { reader?: LifecycleReader } = {}
): Promise<Hash> {
  const wallet = createPublicClient({ transport: custom(provider, { retryCount: 0 }) });
  const read: LifecycleReader = options.reader ?? wallet;
  if ((await wallet.getChainId()) !== call.chainId) throw new LifecycleError("wrong_network");
  const request = { address: call.pool, abi: EmergencyPoolAbi, functionName: "createSubPool", args: [call.poolId] } as const;
  await read.simulateContract({ ...request, account });
  const write = createWalletClient({ account, transport: custom(provider) });
  return write.writeContract({ ...request, chain: null, ...(await polygonFeesFrom(read)) });
}
