import { index, onchainEnum, onchainTable, primaryKey } from "ponder";

// Tables of the per-deploy schema `chain_<sha7>`; readers use the `chain.*` views (ADR-026).
// All amounts are USDC base units (6 decimals) as bigint. Addresses are lowercase hex.

/** Same order as Campaign.CampaignState — the array index is the on-chain enum value. */
export const CAMPAIGN_STATES = [
  "LIVE",
  "SUCCEEDED",
  "FAILED",
  "PAYING",
  "COMPLETED",
  "VOTING",
  "NEEDS_REVIEW",
  "REJECTED",
  "FROZEN",
] as const;

/** Same order as EmergencyPool.AllocationState. */
export const ALLOCATION_STATES = [
  "VOTING",
  "PASSED",
  "REJECTED",
  "NEEDS_REVIEW",
  "RESOLVED_PASS",
  "RESOLVED_REJECT",
  "DELIVERY_FAILED",
] as const;

export const campaignState = onchainEnum("campaign_state", CAMPAIGN_STATES);
export const allocationState = onchainEnum("allocation_state", ALLOCATION_STATES);
export const poolTransferKind = onchainEnum("pool_transfer_kind", ["SETTLE", "SWEEP", "RECLAIM"]);
export const poolContributionSource = onchainEnum("pool_contribution_source", [
  "DIRECT",
  "CAMPAIGN",
]);
/**
 * TASK-023d: see timelockOperation. The Postgres type name must not start with a
 * native type name: Ponder 0.17's generator writes any type starting with "time",
 * "text", "date"… without its schema ("timelock_…" failed with `type does not exist`).
 */
export const timelockOperationState = onchainEnum("scheduled_change_state", [
  "WAITING",
  "EXECUTED",
  "CANCELLED",
]);

export const guardianActionKind = onchainEnum("guardian_action_kind", [
  "FREEZE",
  "RESOLVE",
  "ALLOCATION_RESOLVE",
]);

type ColumnsFn = Extract<Parameters<typeof onchainTable>[1], (...args: never[]) => unknown>;
type Columns = Parameters<ColumnsFn>[0];

/** Where a row came from. `id` of event tables is Ponder's globally unique event id. */
const eventColumns = (t: Columns) => ({
  txHash: t.hex().notNull(),
  logIndex: t.integer().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTime: t.bigint().notNull(),
});

// ── Campaign ─────────────────────────────────────────────────────────────────

export const campaign = onchainTable("campaign", (t) => ({
  address: t.hex().primaryKey(),
  offchainId: t.hex().notNull(),
  beneficiary: t.hex().notNull(),
  beneficiaryType: t.integer().notNull(), // 0 = ORG, 1 = INDIVIDUAL
  target: t.bigint().notNull(),
  deadline: t.bigint().notNull(),
  state: campaignState().notNull(),
  totalRaised: t.bigint().notNull(),
  payoutMode: t.integer(), // null until PayoutModeSet; 0 = SINGLE, 1 = MILESTONES
  released: t.bigint().notNull(),
  feePaid: t.bigint().notNull(),
  tranchesReleased: t.integer().notNull(),
  currentRound: t.integer().notNull(),
  voteEnd: t.bigint().notNull(),
  endTime: t.bigint().notNull(),
  totalRefunded: t.bigint().notNull(),
  totalSentToPool: t.bigint().notNull(),
  poolDonated: t.bigint().notNull(),
  swept: t.boolean().notNull(),
  prevState: campaignState().notNull(),
  frozenAt: t.bigint().notNull(),
  settlementStart: t.bigint().notNull(),
  rejectedRemainder: t.bigint().notNull(),
  fundingPoolId: t.integer(), // EmergencyPool.fundingPool read at each allocation event (bound at proposal before TASK-023c, at delivery since; ADR-061)
  // PlatformConfig values copied into the campaign at creation (Campaign.snap*;
  // read from the chain at the CampaignCreated block, TASK-033b). They decide
  // this campaign's vote window, quorum, approval and delays for its lifetime.
  snapFeeBps: t.integer().notNull(),
  snapSuccessThresholdBps: t.integer().notNull(),
  snapRefundSweepDelay: t.integer().notNull(), // seconds
  snapVoteWindow: t.integer().notNull(), // seconds
  snapQuorumBps: t.integer().notNull(),
  snapApprovalBps: t.integer().notNull(),
  snapReleaseDelay: t.integer().notNull(), // seconds
  ...eventColumns(t),
}));

export const campaignDonor = onchainTable(
  "campaign_donor",
  (t) => ({
    campaign: t.hex().notNull(),
    donor: t.hex().notNull(),
    donated: t.bigint().notNull(),
    preference: t.integer().notNull(), // 0 = REFUND, 1 = EMERGENCY_POOL
    subPoolId: t.integer().notNull(),
    settled: t.boolean().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.campaign, table.donor] }),
    donorIdx: index().on(table.donor),
  })
);

export const donation = onchainTable(
  "donation",
  (t) => ({
    id: t.text().primaryKey(),
    campaign: t.hex().notNull(),
    donor: t.hex().notNull(),
    amount: t.bigint().notNull(),
    preference: t.integer().notNull(), // as chosen with this donation
    subPoolId: t.integer().notNull(),
    ...eventColumns(t),
  }),
  // blockIdx: the worker's donation points read only new donations by block (TASK-056).
  (table) => ({
    campaignIdx: index().on(table.campaign),
    donorIdx: index().on(table.donor),
    blockIdx: index().on(table.blockNumber),
  })
);

export const voteRound = onchainTable(
  "vote_round",
  (t) => ({
    campaign: t.hex().notNull(),
    round: t.integer().notNull(),
    bundleHash: t.hex().notNull(),
    voteEnd: t.bigint().notNull(),
    yesVotes: t.bigint().notNull(),
    noVotes: t.bigint().notNull(),
    outcome: campaignState(), // null while the round is open
    closedAt: t.bigint(),
    ...eventColumns(t),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.campaign, table.round] }) })
);

export const vote = onchainTable(
  "vote",
  (t) => ({
    campaign: t.hex().notNull(),
    round: t.integer().notNull(),
    voter: t.hex().notNull(),
    approve: t.boolean().notNull(),
    weight: t.bigint().notNull(),
    ...eventColumns(t),
  }),
  // blockIdx: the worker's vote points read only new votes by block (VOTE-POINTS-WATERMARK).
  (table) => ({
    pk: primaryKey({ columns: [table.campaign, table.round, table.voter] }),
    blockIdx: index().on(table.blockNumber),
  })
);

export const trancheRelease = onchainTable(
  "tranche_release",
  (t) => ({
    id: t.text().primaryKey(),
    campaign: t.hex().notNull(),
    trancheIndex: t.integer().notNull(), // 0 for SINGLE, 0..2 for MILESTONES
    beneficiary: t.hex().notNull(),
    amount: t.bigint().notNull(),
    fee: t.bigint().notNull(),
    ...eventColumns(t),
  }),
  (table) => ({ campaignIdx: index().on(table.campaign) })
);

export const refund = onchainTable(
  "refund",
  (t) => ({
    id: t.text().primaryKey(),
    campaign: t.hex().notNull(),
    donor: t.hex().notNull(),
    amount: t.bigint().notNull(),
    ...eventColumns(t),
  }),
  (table) => ({ campaignIdx: index().on(table.campaign) })
);

export const guardianAction = onchainTable("guardian_action", (t) => ({
  id: t.text().primaryKey(),
  kind: guardianActionKind().notNull(),
  campaign: t.hex(),
  allocationId: t.bigint(),
  actor: t.hex().notNull(),
  approve: t.boolean(), // null for FREEZE
  resultState: t.text().notNull(),
  ...eventColumns(t),
}));

// ── Emergency pool (tables exist for stable views; filled by TASK-006 PR B) ───

export const pool = onchainTable("pool", (t) => ({
  id: t.integer().primaryKey(),
  balance: t.bigint().notNull(),
  totalContributed: t.bigint().notNull(),
}));

export const poolContribution = onchainTable("pool_contribution", (t) => ({
  id: t.text().primaryKey(),
  poolId: t.integer().notNull(),
  donor: t.hex().notNull(),
  amount: t.bigint().notNull(),
  source: poolContributionSource().notNull(),
  campaign: t.hex(),
  ...eventColumns(t),
}));

export const poolTransfer = onchainTable("pool_transfer", (t) => ({
  id: t.text().primaryKey(),
  kind: poolTransferKind().notNull(),
  poolId: t.integer().notNull(),
  campaign: t.hex().notNull(),
  donor: t.hex(),
  amount: t.bigint().notNull(),
  ...eventColumns(t),
}));

export const allocation = onchainTable("allocation", (t) => ({
  id: t.bigint().primaryKey(),
  poolId: t.integer().notNull(),
  campaign: t.hex().notNull(),
  amount: t.bigint().notNull(),
  delivered: t.bigint(),
  reasonHash: t.hex().notNull(),
  yesVotes: t.bigint().notNull(),
  noVotes: t.bigint().notNull(),
  voteEnd: t.bigint().notNull(),
  proposalBlock: t.bigint().notNull(),
  // The quorum and approval rule snapshotted at the proposal (TASK-014a; read once with getAllocation).
  snapQuorumBps: t.integer().notNull(),
  snapApprovalBps: t.integer().notNull(),
  state: allocationState().notNull(),
  ...eventColumns(t),
}));

export const allocationVote = onchainTable(
  "allocation_vote",
  (t) => ({
    allocationId: t.bigint().notNull(),
    voter: t.hex().notNull(),
    approve: t.boolean().notNull(),
    weight: t.bigint().notNull(),
    ...eventColumns(t),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.allocationId, table.voter] }) })
);

// ── TimelockController (TASK-023d, review M-02) ──────────────────────────────
// Every operation scheduled on the timelock, whoever scheduled it (the admin
// console or anything else), so that changes to PlatformConfig are public before
// they take effect. `state` mirrors getTimestamp(id): WAITING = ready_at,
// EXECUTED = 1 (done), CANCELLED = 0 (unset). Whether a waiting operation can be
// executed yet is `ready_at <= now` — decided by the reader, not stored.

export const timelockOperation = onchainTable("timelock_operation", (t) => ({
  id: t.hex().primaryKey(),
  /** Calls in the batch (CallScheduled indexes 0..calls-1). */
  calls: t.integer().notNull(),
  predecessor: t.hex().notNull(),
  /** From CallSalt; null when the salt is zero (no CallSalt event). */
  salt: t.hex(),
  delay: t.bigint().notNull(),
  /** Unix seconds from which the operation can be executed: schedule block time + delay. */
  readyAt: t.bigint().notNull(),
  state: timelockOperationState().notNull(),
  executedTxHash: t.hex(),
  executedBlockTime: t.bigint(),
  cancelledTxHash: t.hex(),
  cancelledBlockTime: t.bigint(),
  // Where it was (last) scheduled: an operation cancelled and scheduled again keeps its id.
  ...eventColumns(t),
}));

export const timelockCall = onchainTable(
  "timelock_call",
  (t) => ({
    /** The operation id (`operation` and `operation_id` are reserved by Ponder). */
    opId: t.hex().notNull(),
    index: t.integer().notNull(),
    target: t.hex().notNull(),
    value: t.bigint().notNull(),
    data: t.hex().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.opId, table.index] }) })
);
