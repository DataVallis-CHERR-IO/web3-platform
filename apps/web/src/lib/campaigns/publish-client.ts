import {
  createPublicClient, createWalletClient, custom, getAddress, isAddressEqual, zeroAddress,
  type Address, type EIP1193Provider, type Hash, type Hex,
} from "viem";
import { CampaignFactoryAbi, PlatformConfigAbi } from "@cherrio/contracts/abis";

// Browser side of on-chain publishing (TASK-010c, ADR-035). Runs against the
// admin's own wallet provider (MetaMask through Privy): every read goes through
// that provider, so the web app needs no RPC key. Pure logic, no React, so it is
// unit-tested with a fake EIP-1193 provider.

/** What POST /api/admin/campaigns/:id/publish/prepare returns. */
export interface PreparedPublishCall {
  chainId: number;
  factory: Address;
  platformConfig: Address;
  predictedAddress: Address;
  params: { offchainId: Hex; beneficiary: Address; target: string; deadline: string; beneficiaryType: 0 };
}

export type PublishCheckFailure =
  | "wrong_chain"
  | "not_operator"
  | "prediction_mismatch"
  | "previous_pending";

/** A check before sending failed; nothing was sent. */
export class PublishCheckError extends Error {
  constructor(public readonly code: PublishCheckFailure) {
    super(code);
    this.name = "PublishCheckError";
  }
}

export type PublishOutcome =
  /** The factory already has a campaign for this offchain id — only link it. */
  | { kind: "already_on_chain"; address: Address }
  | { kind: "sent"; txHash: Hash };

const clients = (provider: EIP1193Provider, account: Address) => ({
  read: createPublicClient({ transport: custom(provider) }),
  write: createWalletClient({ account, transport: custom(provider) }),
});

/** Does this wallet hold OPERATOR_ROLE on PlatformConfig? (Read through the wallet's own provider.) */
export async function isOperator(provider: EIP1193Provider, account: Address, platformConfig: Address): Promise<boolean> {
  const read = createPublicClient({ transport: custom(provider) });
  const role = await read.readContract({ address: platformConfig, abi: PlatformConfigAbi, functionName: "OPERATOR_ROLE" });
  return read.readContract({ address: platformConfig, abi: PlatformConfigAbi, functionName: "hasRole", args: [role, account] });
}

/**
 * Checks everything that can be checked before signing, then sends
 * CampaignFactory.createCampaign:
 * 1. the wallet is on the expected chain;
 * 2. the account holds OPERATOR_ROLE;
 * 3. the factory predicts the same clone address as the server;
 * 4. the factory has no campaign for this offchain id yet (else: link only);
 * 5. an earlier transaction of this campaign is not still pending.
 */
export async function publishCampaign(
  provider: EIP1193Provider,
  account: Address,
  prepared: PreparedPublishCall,
  previousTxHash: Hash | null
): Promise<PublishOutcome> {
  const { read, write } = clients(provider, account);
  const { factory, params } = prepared;

  if ((await read.getChainId()) !== prepared.chainId) throw new PublishCheckError("wrong_chain");
  if (!(await isOperator(provider, account, prepared.platformConfig))) throw new PublishCheckError("not_operator");

  const predicted = await read.readContract({
    address: factory, abi: CampaignFactoryAbi, functionName: "predictCampaignAddress", args: [params.offchainId],
  });
  if (!isAddressEqual(predicted, prepared.predictedAddress)) throw new PublishCheckError("prediction_mismatch");

  const existing = await read.readContract({
    address: factory, abi: CampaignFactoryAbi, functionName: "campaigns", args: [params.offchainId],
  });
  if (!isAddressEqual(existing, zeroAddress)) return { kind: "already_on_chain", address: getAddress(existing) };

  if (previousTxHash) {
    const previous = await read.getTransaction({ hash: previousTxHash }).catch(() => null);
    if (previous && previous.blockNumber === null) throw new PublishCheckError("previous_pending");
  }

  const txHash = await write.writeContract({
    address: factory,
    abi: CampaignFactoryAbi,
    functionName: "createCampaign",
    args: [{
      offchainId: params.offchainId,
      beneficiary: params.beneficiary,
      target: BigInt(params.target),
      deadline: BigInt(params.deadline),
      beneficiaryType: params.beneficiaryType,
    }],
    chain: null,
  });
  return { kind: "sent", txHash };
}

/** Waits for the receipt through the wallet's provider. true = mined and succeeded. */
export async function waitForPublish(provider: EIP1193Provider, txHash: Hash, timeoutMs = 180_000): Promise<boolean> {
  const read = createPublicClient({ transport: custom(provider) });
  const receipt = await read.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs, pollingInterval: 3_000 });
  return receipt.status === "success";
}
