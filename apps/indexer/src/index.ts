import { ponder } from "ponder:registry";
import {
  campaign,
  campaignDonor,
  donation,
  guardianAction,
  refund,
  trancheRelease,
  vote,
  voteRound,
  CAMPAIGN_STATES,
} from "ponder:schema";
import { resolveIndexerEnv } from "../lib/env";
import { origin } from "../lib/origin";

// Handlers mirror the storage writes of Campaign.sol one to one, so that every
// column equals its contract view at the same block (checked by `pnpm reconcile`).

const poolAddress = resolveIndexerEnv().emergencyPool.address.toLowerCase();

const SINGLE = 0;

type CampaignState = (typeof CAMPAIGN_STATES)[number];

function stateName(value: number): CampaignState {
  const name = CAMPAIGN_STATES[value];
  if (!name) throw new Error(`Unknown CampaignState ${value}`);
  return name;
}

// ── CampaignFactory ──────────────────────────────────────────────────────────

ponder.on("CampaignFactory:CampaignCreated", async ({ event, context }) => {
  await context.db.insert(campaign).values({
    address: event.args.campaign,
    offchainId: event.args.offchainId,
    beneficiary: event.args.beneficiary,
    beneficiaryType: event.args.beneficiaryType,
    target: event.args.target,
    deadline: event.args.deadline,
    state: "LIVE",
    totalRaised: 0n,
    payoutMode: null,
    released: 0n,
    feePaid: 0n,
    tranchesReleased: 0,
    currentRound: 0,
    voteEnd: 0n,
    endTime: 0n,
    totalRefunded: 0n,
    totalSentToPool: 0n,
    poolDonated: 0n,
    swept: false,
    prevState: "LIVE",
    frozenAt: 0n,
    settlementStart: 0n,
    rejectedRemainder: 0n,
    fundingPoolId: null,
    ...origin(event),
  });
});

// ── Campaign: donations ──────────────────────────────────────────────────────

ponder.on("Campaign:Donated", async ({ event, context }) => {
  const address = event.log.address;
  const { donor, amount, preference, subPoolId } = event.args;
  const fromPool = donor.toLowerCase() === poolAddress;

  await context.db.insert(donation).values({
    id: event.id,
    campaign: address,
    donor,
    amount,
    preference,
    subPoolId,
    ...origin(event),
  });

  await context.db
    .insert(campaignDonor)
    .values({ campaign: address, donor, donated: amount, preference, subPoolId, settled: false })
    // donateFromPool() sets the preference but leaves donorSubPoolId untouched.
    .onConflictDoUpdate((row) => ({
      donated: row.donated + amount,
      preference,
      subPoolId: fromPool ? row.subPoolId : subPoolId,
    }));

  await context.db.update(campaign, { address }).set((row) => ({
    totalRaised: row.totalRaised + amount,
    poolDonated: fromPool ? row.poolDonated + amount : row.poolDonated,
  }));
});

ponder.on("Campaign:PreferenceSet", async ({ event, context }) => {
  await context.db
    .update(campaignDonor, { campaign: event.log.address, donor: event.args.donor })
    .set({ preference: event.args.preference, subPoolId: event.args.subPoolId });
});

// ── Campaign: lifecycle ──────────────────────────────────────────────────────

ponder.on("Campaign:Finalized", async ({ event, context }) => {
  const state = stateName(event.args.newState);
  const now = event.block.timestamp;
  await context.db.update(campaign, { address: event.log.address }).set((row) => ({
    state,
    endTime: now,
    settlementStart: state === "FAILED" ? now : row.settlementStart,
  }));
});

ponder.on("Campaign:PayoutModeSet", async ({ event, context }) => {
  await context.db
    .update(campaign, { address: event.log.address })
    .set({ payoutMode: event.args.mode });
});

ponder.on("Campaign:TrancheReleased", async ({ event, context }) => {
  const address = event.log.address;
  const row = await context.db.find(campaign, { address });
  if (!row) throw new Error(`TrancheReleased for unknown campaign ${address}`);

  await context.db.insert(trancheRelease).values({
    id: event.id,
    campaign: address,
    trancheIndex: row.tranchesReleased,
    beneficiary: event.args.beneficiary,
    amount: event.args.amount,
    fee: event.args.fee,
    ...origin(event),
  });

  // SINGLE pays everything at once and does not count tranches.
  const single = row.payoutMode === SINGLE;
  const tranchesReleased = single ? row.tranchesReleased : row.tranchesReleased + 1;
  await context.db.update(campaign, { address }).set({
    released: row.released + event.args.amount,
    feePaid: row.feePaid + event.args.fee,
    tranchesReleased,
    state: single || tranchesReleased === 3 ? "COMPLETED" : "PAYING",
  });
});

// ── Campaign: milestones voting ──────────────────────────────────────────────

ponder.on("Campaign:EvidenceSubmitted", async ({ event, context }) => {
  const address = event.log.address;
  const { round, bundleHash, voteEnd } = event.args;

  await context.db.insert(voteRound).values({
    campaign: address,
    round,
    bundleHash,
    voteEnd,
    yesVotes: 0n,
    noVotes: 0n,
    outcome: null,
    closedAt: null,
    ...origin(event),
  });
  await context.db
    .update(campaign, { address })
    .set({ state: "VOTING", currentRound: round, voteEnd });
});

ponder.on("Campaign:Voted", async ({ event, context }) => {
  const address = event.log.address;
  const { round, voter, approve, weight } = event.args;

  await context.db
    .insert(vote)
    .values({ campaign: address, round, voter, approve, weight, ...origin(event) });
  await context.db.update(voteRound, { campaign: address, round }).set((row) => ({
    yesVotes: approve ? row.yesVotes + weight : row.yesVotes,
    noVotes: approve ? row.noVotes : row.noVotes + weight,
  }));
});

ponder.on("Campaign:VoteClosed", async ({ event, context }) => {
  const address = event.log.address;
  const outcome = stateName(event.args.outcome);
  const now = event.block.timestamp;

  await context.db.update(voteRound, { campaign: address, round: event.args.round }).set({
    yesVotes: event.args.yesVotes,
    noVotes: event.args.noVotes,
    outcome,
    closedAt: now,
  });
  // An approved round already emitted TrancheReleased; `outcome` is the state after it.
  await context.db.update(campaign, { address }).set((row) => ({
    state: outcome,
    ...(outcome === "REJECTED" ? rejection(row, now) : {}),
  }));
});

/** Campaign._reject(): what is left for pro-rata refunds, and when the sweep delay starts. */
function rejection(row: { totalRaised: bigint; released: bigint; feePaid: bigint }, now: bigint) {
  return {
    rejectedRemainder: row.totalRaised - row.released - row.feePaid,
    settlementStart: now,
  };
}

// ── Campaign: guardian ───────────────────────────────────────────────────────

ponder.on("Campaign:Frozen", async ({ event, context }) => {
  const address = event.log.address;
  await context.db.insert(guardianAction).values({
    id: event.id,
    kind: "FREEZE",
    campaign: address,
    allocationId: null,
    actor: event.transaction.from,
    approve: null,
    resultState: "FROZEN",
    ...origin(event),
  });
  await context.db.update(campaign, { address }).set({
    state: "FROZEN",
    prevState: stateName(event.args.prevState),
    frozenAt: event.block.timestamp,
  });
});

ponder.on("Campaign:Resolved", async ({ event, context }) => {
  const address = event.log.address;
  const { approve } = event.args;
  const newState = stateName(event.args.newState);
  const now = event.block.timestamp;
  const row = await context.db.find(campaign, { address });
  if (!row) throw new Error(`Resolved for unknown campaign ${address}`);

  await context.db.insert(guardianAction).values({
    id: event.id,
    kind: "RESOLVE",
    campaign: address,
    allocationId: null,
    actor: event.transaction.from,
    approve,
    resultState: newState,
    ...origin(event),
  });

  // Unfreezing a vote extends its window by the time spent frozen.
  // (From NEEDS_REVIEW the row is already PAYING/COMPLETED via TrancheReleased.)
  let voteEnd = row.voteEnd;
  if (approve && row.state === "FROZEN" && newState === "VOTING") {
    voteEnd = row.voteEnd + (now - row.frozenAt);
    await context.db
      .update(voteRound, { campaign: address, round: row.currentRound })
      .set({ voteEnd });
  }

  await context.db.update(campaign, { address }).set({
    state: newState,
    voteEnd,
    ...(approve ? {} : rejection(row, now)),
  });
});

// ── Campaign: refunds and pool settlement ────────────────────────────────────

ponder.on("Campaign:Refunded", async ({ event, context }) => {
  const address = event.log.address;
  const { donor, amount } = event.args;

  await context.db
    .insert(refund)
    .values({ id: event.id, campaign: address, donor, amount, ...origin(event) });
  await context.db.update(campaignDonor, { campaign: address, donor }).set({ settled: true });
  await context.db
    .update(campaign, { address })
    .set((row) => ({ totalRefunded: row.totalRefunded + amount }));
});

// The pool_transfer row is written from EmergencyPool:CampaignInflow (PR B), which
// carries the effective pool id; here only the campaign-side accounting.
ponder.on("Campaign:SentToPool", async ({ event, context }) => {
  const address = event.log.address;
  const { donor, amount } = event.args;

  await context.db.update(campaignDonor, { campaign: address, donor }).set({ settled: true });
  await context.db
    .update(campaign, { address })
    .set((row) => ({ totalSentToPool: row.totalSentToPool + amount }));
});

ponder.on("Campaign:Swept", async ({ event, context }) => {
  await context.db.update(campaign, { address: event.log.address }).set((row) => ({
    swept: true,
    totalSentToPool: row.totalSentToPool + event.args.amount,
  }));
});
