import type postgres from "postgres";
import type { Address, PublicClient } from "viem";
import { CampaignAbi, CampaignFactoryAbi } from "@cherrio/contracts/abis";

// Compares indexed rows with the contract view functions, all read at the last
// indexed block so that a moving chain cannot produce false mismatches.
// Covers campaign, campaign_donor, vote_round and vote (pool tables: TASK-006 PR B).

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
}

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

/** Ponder checkpoint: 10 digits block time, 16 digits chain id, 16 digits block number, … */
function checkpointBlock(checkpoint: string): bigint {
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

  const view = (address: Address, functionName: string, args: unknown[] = []) =>
    client.readContract({
      abi: CampaignAbi,
      address,
      functionName,
      args,
      blockNumber: block,
    } as Parameters<PublicClient["readContract"]>[0]) as Promise<unknown>;
  const factoryView = (functionName: string, args: unknown[]) =>
    client.readContract({
      abi: CampaignFactoryAbi,
      address: factory,
      functionName,
      args,
      blockNumber: block,
    } as Parameters<PublicClient["readContract"]>[0]) as Promise<unknown>;

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

  return { block, checked, mismatches };
}
