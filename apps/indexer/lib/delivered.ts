import { decodeEventLog, type Hex } from "viem";
import { CampaignAbi } from "@cherrio/contracts/abis";

export interface ReceiptLog {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
  logIndex: number;
}

interface DeliveredParams {
  logs: readonly ReceiptLog[];
  campaign: Hex;
  pool: Hex;
  /** logIndex of the AllocationClosed / AllocationResolved event. */
  beforeLogIndex: number;
  allocationId: bigint;
}

/**
 * What the campaign actually took from a delivered allocation (it clips to its
 * remaining target). Only the campaign's own Donated log has this number: the
 * last one before the allocation event, in the same transaction, with the pool
 * as donor. A delivered allocation without such a log is a bug — fail loudly,
 * never assume the full amount or zero.
 */
export function deliveredFromLogs(params: DeliveredParams): bigint {
  const campaign = params.campaign.toLowerCase();
  const pool = params.pool.toLowerCase();
  let delivered: { amount: bigint; logIndex: number } | undefined;

  for (const log of params.logs) {
    if (log.logIndex >= params.beforeLogIndex) continue;
    if (log.address.toLowerCase() !== campaign) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: CampaignAbi,
        topics: [...log.topics] as [Hex, ...Hex[]],
        data: log.data,
      });
    } catch {
      continue; // not a Campaign event
    }
    if (decoded.eventName !== "Donated") continue;
    if (decoded.args.donor.toLowerCase() !== pool) continue;
    if (!delivered || log.logIndex > delivered.logIndex) {
      delivered = { amount: decoded.args.amount, logIndex: log.logIndex };
    }
  }

  if (!delivered) {
    throw new Error(
      `Allocation ${params.allocationId} was delivered but its transaction has no Donated log from ${params.campaign} with the pool as donor`
    );
  }
  return delivered.amount;
}
