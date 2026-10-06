import type postgres from "postgres";
import type { Address, PublicClient } from "viem";
import { CampaignAbi, CampaignFactoryAbi, EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { limiter, withReadRetry, type RetryOptions } from "./rpc-read";

// Compares indexed rows with the contract view functions, all read at the last
// indexed block so that a moving chain cannot produce false mismatches.
// Covers every table that mirrors contract storage; event-log tables are covered
// through the sums they feed (donated, contributed, delivered).

export interface Mismatch {
  table: string;
  key: string;
  field: string;
  indexed: string;
  onchain: string;
}

export interface ReconcileResult {
  block: bigint;
  checked: number;
  mismatches: Mismatch[];
}

interface ReconcileParams {
  sql: postgres.Sql;
  /** Schema to read: the `chain` views in every deployed environment. */
  schema: string;
  client: PublicClient;
  factory: Address;
  pool: Address;
  /** Reads in flight at once (default READ_CONCURRENCY). */
  concurrency?: number;
  /** Pauses before repeating a rate-limited or empty read (default ~31 s in all). */
  retry?: RetryOptions;
}

/** Few enough for a free-tier backup RPC's per-second limit; reconcile is not time-critical. */
export const READ_CONCURRENCY = 4;

type Row = Record<string, unknown>;

const STATES = [
  "LIVE",
  "SUCCEEDED",
  "FAILED",
  "PAYING",
  "COMPLETED",
  "VOTING",
  "NEEDS_REVIEW",
  "REJECTED",
  "FROZEN",
];

const ALLOCATION_STATES = [
  "VOTING",
  "PASSED",
  "REJECTED",
  "NEEDS_REVIEW",
  "RESOLVED_PASS",
  "RESOLVED_REJECT",
  "DELIVERY_FAILED",
];

/**
 * Block number of a Ponder 0.17 checkpoint: 75 decimal digits =
 * block time (10) + chain id (16) + block number (16) + tx index (16) + event type (1) + event index (16).
 */
export function checkpointBlock(checkpoint: string): bigint {
  if (!/^\d{75}$/.test(checkpoint)) {
    throw new Error(`Unexpected Ponder checkpoint format: "${checkpoint}"`);
  }
  return BigInt(checkpoint.slice(26, 42));
}

const norm = (value: unknown) => String(value).toLowerCase();

export async function reconcile(params: ReconcileParams): Promise<ReconcileResult> {
  const { sql, client, factory } = params;
  const db = sql(params.schema);

  const checkpoints = await sql<{ latest_checkpoint: string }[]>`
    select latest_checkpoint from ${db}._ponder_checkpoint`;
  if (checkpoints.length !== 1) {
    throw new Error(`Expected one indexed chain in "${params.schema}", found ${checkpoints.length}`);
  }
  const block = checkpointBlock(checkpoints[0]!.latest_checkpoint);

  const mismatches: Mismatch[] = [];
  let checked = 0;
  const check = (table: string, key: string, field: string, indexed: unknown, onchain: unknown) => {
    checked += 1;
    if (norm(indexed) !== norm(onchain)) {
      mismatches.push({ table, key, field, indexed: norm(indexed), onchain: norm(onchain) });
    }
  };

  // Every read: at most READ_CONCURRENCY in flight, a rate limit or an empty
  // "0x" answer repeated after a pause (lib/rpc-read.ts) — never a value.
  const limit = limiter(params.concurrency ?? READ_CONCURRENCY);
  const read = (abi: unknown, address: Address, functionName: string, args: unknown[]) =>
    limit(() =>
      withReadRetry(
        () =>
          client.readContract({ abi, address, functionName, args, blockNumber: block } as Parameters<
            PublicClient["readContract"]
          >[0]) as Promise<unknown>,
        params.retry
      )
    );
  const view = (address: Address, functionName: string, args: unknown[] = []) => read(CampaignAbi, address, functionName, args);
  const factoryView = (functionName: string, args: unknown[]) => read(CampaignFactoryAbi, factory, functionName, args);
  const poolView = (functionName: string, args: unknown[] = []) => read(EmergencyPoolAbi, params.pool, functionName, args);

  const campaigns = await sql<Row[]>`select * from ${db}.campaign order by address`;
  for (const row of campaigns) {
    const address = row.address as Address;
    const c = (field: string, indexed: unknown, onchain: unknown) =>
      check("campaign", address, field, indexed, onchain);

    // column → view function, compared as-is
    const direct: [string, string][] = [
      ["offchain_id", "offchainId"],
      ["beneficiary", "beneficiary"],
      ["beneficiary_type", "beneficiaryType"],
      ["target", "target"],
      ["deadline", "deadline"],
      ["total_raised", "totalRaised"],
      ["released", "released"],
      ["fee_paid", "feePaid"],
      ["tranches_released", "tranchesReleased"],
      ["current_round", "currentRound"],
      ["vote_end", "voteEnd"],
      ["end_time", "endTime"],
      ["total_refunded", "totalRefunded"],
      ["total_sent_to_pool", "totalSentToPool"],
      ["pool_donated", "poolDonated"],
      ["swept", "swept"],
      ["frozen_at", "frozenAt"],
      ["settlement_start", "settlementStart"],
      ["rejected_remainder", "rejectedRemainder"],
      ["snap_fee_bps", "snapFeeBps"],
      ["snap_success_threshold_bps", "snapSuccessThresholdBps"],
      ["snap_refund_sweep_delay", "snapRefundSweepDelay"],
      ["snap_vote_window", "snapVoteWindow"],
      ["snap_quorum_bps", "snapQuorumBps"],
      ["snap_approval_bps", "snapApprovalBps"],
      ["snap_release_delay", "snapReleaseDelay"],
    ];
    const values = await Promise.all(direct.map(([, fn]) => view(address, fn)));
    direct.forEach(([column], i) => c(column, row[column], values[i]));

    const [state, prevState, payoutMode, payoutModeSet, isCampaign, registered] = await Promise.all([
      view(address, "state"),
      view(address, "prevState"),
      view(address, "payoutMode"),
      view(address, "payoutModeSet"),
      factoryView("isCampaign", [address]),
      factoryView("campaigns", [row.offchain_id]),
    ]);
    c("state", row.state, STATES[Number(state)]);
    c("prev_state", row.prev_state, STATES[Number(prevState)]);
    c("payout_mode (set)", row.payout_mode !== null, payoutModeSet);
    c("payout_mode", row.payout_mode ?? 0, payoutMode);
    c("factory.isCampaign", true, isCampaign);
    c("factory.campaigns(offchainId)", address, registered);

    // What the pool delivered to this campaign is exactly its poolDonated().
    const [hasFundingPool, fundingPool, poolDonated, [delivered]] = await Promise.all([
      poolView("hasFundingPool", [address]),
      poolView("fundingPool", [address]),
      view(address, "poolDonated"),
      sql<Row[]>`
        select coalesce(sum(delivered), 0) as total from ${db}.allocation where campaign = ${address}`,
    ]);
    c("funding_pool_id (set)", row.funding_pool_id !== null, hasFundingPool);
    c("funding_pool_id", row.funding_pool_id ?? 0, fundingPool);
    c("sum(allocation.delivered)", delivered!.total, poolDonated);

    // The contract keeps yes/no votes of the latest round until the next one opens.
    const [round] = await sql<Row[]>`
      select * from ${db}.vote_round where campaign = ${address} order by round desc limit 1`;
    if (round) {
      const key = `${address}/${String(round.round)}`;
      const [yes, no, voteEnd] = await Promise.all([
        view(address, "yesVotes"),
        view(address, "noVotes"),
        view(address, "voteEnd"),
      ]);
      check("vote_round", key, "round", round.round, row.current_round);
      check("vote_round", key, "yes_votes", round.yes_votes, yes);
      check("vote_round", key, "no_votes", round.no_votes, no);
      check("vote_round", key, "vote_end", round.vote_end, voteEnd);
    }
  }

  const donors = await sql<Row[]>`select * from ${db}.campaign_donor order by campaign, donor`;
  for (const row of donors) {
    const address = row.campaign as Address;
    const key = `${address}/${String(row.donor)}`;
    const [donated, preference, subPoolId, settled] = await Promise.all([
      view(address, "donated", [row.donor]),
      view(address, "preference", [row.donor]),
      view(address, "donorSubPoolId", [row.donor]),
      view(address, "settled", [row.donor]),
    ]);
    check("campaign_donor", key, "donated", row.donated, donated);
    check("campaign_donor", key, "preference", row.preference, preference);
    check("campaign_donor", key, "sub_pool_id", row.sub_pool_id, subPoolId);
    check("campaign_donor", key, "settled", row.settled, settled);
  }

  const votes = await sql<Row[]>`select * from ${db}.vote order by campaign, round, voter`;
  for (const row of votes) {
    const address = row.campaign as Address;
    const key = `${address}/${String(row.round)}/${String(row.voter)}`;
    const [hasVoted, donated] = await Promise.all([
      view(address, "hasVoted", [row.voter, row.round]),
      view(address, "donated", [row.voter]),
    ]);
    check("vote", key, "hasVoted", true, hasVoted);
    // Donations close before voting opens, so the weight equals donated[voter].
    check("vote", key, "weight", row.weight, donated);
  }

  const pools = await sql<Row[]>`select * from ${db}.pool order by id`;
  for (const row of pools) {
    const key = String(row.id);
    const [exists, balance, totalContributed] = await Promise.all([
      poolView("poolExists", [row.id]),
      poolView("poolBalance", [row.id]),
      poolView("totalContributedAt", [row.id, block]),
    ]);
    check("pool", key, "poolExists", true, exists);
    check("pool", key, "balance", row.balance, balance);
    check("pool", key, "total_contributed", row.total_contributed, totalContributed);
  }

  const contributors = await sql<Row[]>`
    select pool_id, donor, sum(amount) as contributed from ${db}.pool_contribution
    group by pool_id, donor order by pool_id, donor`;
  for (const row of contributors) {
    const onchain = await poolView("contributedAt", [row.pool_id, row.donor, block]);
    const key = `${String(row.pool_id)}/${String(row.donor)}`;
    check("pool_contribution", key, "sum(amount)", row.contributed, onchain);
  }

  const allocations = await sql<Row[]>`select * from ${db}.allocation order by id`;
  check("allocation", "*", "allocationCount", allocations.length, await poolView("allocationCount"));
  for (const row of allocations) {
    const onchain = (await poolView("getAllocation", [row.id])) as Record<string, unknown>;
    const a = (field: string, indexed: unknown, value: unknown) =>
      check("allocation", String(row.id), field, indexed, value);
    a("pool_id", row.pool_id, onchain.poolId);
    a("campaign", row.campaign, onchain.campaign);
    a("amount", row.amount, onchain.amount);
    a("reason_hash", row.reason_hash, onchain.reasonHash);
    a("yes_votes", row.yes_votes, onchain.yesVotes);
    a("no_votes", row.no_votes, onchain.noVotes);
    a("vote_end", row.vote_end, onchain.voteEnd);
    a("proposal_block", row.proposal_block, onchain.proposalBlock);
    a("state", row.state, ALLOCATION_STATES[Number(onchain.state)]);
  }

  const allocationVotes = await sql<Row[]>`
    select * from ${db}.allocation_vote order by allocation_id, voter`;
  for (const row of allocationVotes) {
    const key = `${String(row.allocation_id)}/${String(row.voter)}`;
    const voted = await poolView("hasVotedAllocation", [row.allocation_id, row.voter]);
    check("allocation_vote", key, "hasVotedAllocation", true, voted);
  }

  return { block, checked, mismatches };
}
