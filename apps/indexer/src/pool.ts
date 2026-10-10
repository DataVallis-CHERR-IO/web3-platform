import { ponder } from "ponder:registry";
import {
  allocation,
  allocationVote,
  campaign,
  guardianAction,
  pool,
  poolContribution,
  poolTransfer,
  ALLOCATION_STATES,
} from "ponder:schema";
import { zeroAddress, type Hex } from "viem";
import { EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { deliveredFromLogs, type ReceiptLog } from "../lib/delivered";
import { resolveIndexerEnv } from "../lib/env";
import { origin } from "../lib/origin";

// Handlers mirror the storage writes of EmergencyPool.sol: `pool.balance` equals
// poolBalance(id) and `pool.total_contributed` equals totalContributedAt(id, block).

const poolAddress = resolveIndexerEnv().emergencyPool.address;

function allocationStateName(value: number) {
  const name = ALLOCATION_STATES[value];
  if (!name) throw new Error(`Unknown AllocationState ${value}`);
  return name;
}

/** Fetches the receipt (Ponder's own event.transactionReceipt carries no logs; this call is cached). */
async function deliveredAmount(
  client: { getTransactionReceipt: (args: { hash: Hex }) => Promise<{ logs: ReceiptLog[] }> },
  event: { transaction: { hash: Hex }; log: { logIndex: number } },
  campaignAddress: Hex,
  allocationId: bigint
): Promise<bigint> {
  const { logs } = await client.getTransactionReceipt({ hash: event.transaction.hash });
  return deliveredFromLogs({
    logs,
    campaign: campaignAddress,
    pool: poolAddress,
    beforeLogIndex: event.log.logIndex,
    allocationId,
  });
}

// ── Sub-pools and inflows ────────────────────────────────────────────────────

// The constructor creates the general pool without an event.
ponder.on("EmergencyPool:setup", async ({ context }) => {
  await context.db
    .insert(pool)
    .values({ id: 0, balance: 0n, totalContributed: 0n })
    .onConflictDoNothing();
});

ponder.on("EmergencyPool:SubPoolCreated", async ({ event, context }) => {
  await context.db
    .insert(pool)
    .values({ id: event.args.poolId, balance: 0n, totalContributed: 0n });
});

ponder.on("EmergencyPool:PoolDonated", async ({ event, context }) => {
  const { poolId, donor, amount } = event.args;
  await context.db.insert(poolContribution).values({
    id: event.id,
    poolId,
    donor,
    amount,
    source: "DIRECT",
    campaign: null,
    ...origin(event),
  });
  await context.db.update(pool, { id: poolId }).set((row) => ({
    balance: row.balance + amount,
    totalContributed: row.totalContributed + amount,
  }));
});

// `poolId` is the effective pool (unknown sub-pools fall back to 0).
// A sweep has no donor: it raises the balance but gives nobody voting weight.
ponder.on("EmergencyPool:CampaignInflow", async ({ event, context }) => {
  const { poolId, donor, amount } = event.args;
  const sweep = donor === zeroAddress;

  await context.db.insert(poolTransfer).values({
    id: event.id,
    kind: sweep ? "SWEEP" : "SETTLE",
    poolId,
    campaign: event.args.campaign,
    donor: sweep ? null : donor,
    amount,
    ...origin(event),
  });
  if (!sweep) {
    await context.db.insert(poolContribution).values({
      id: event.id,
      poolId,
      donor,
      amount,
      source: "CAMPAIGN",
      campaign: event.args.campaign,
      ...origin(event),
    });
  }
  await context.db.update(pool, { id: poolId }).set((row) => ({
    balance: row.balance + amount,
    totalContributed: sweep ? row.totalContributed : row.totalContributed + amount,
  }));
});

ponder.on("EmergencyPool:ReclaimedFromCampaign", async ({ event, context }) => {
  const { amount } = event.args;
  const source = await context.db.find(campaign, { address: event.args.campaign });
  if (!source) throw new Error(`ReclaimedFromCampaign for unknown campaign ${event.args.campaign}`);
  const poolId = source.fundingPoolId ?? 0;

  await context.db.insert(poolTransfer).values({
    id: event.id,
    kind: "RECLAIM",
    poolId,
    campaign: event.args.campaign,
    donor: null,
    amount,
    ...origin(event),
  });
  await context.db
    .update(pool, { id: poolId })
    .set((row) => ({ balance: row.balance + amount }));
});

// ── Allocations ──────────────────────────────────────────────────────────────

ponder.on("EmergencyPool:AllocationProposed", async ({ event, context }) => {
  const { id, poolId, amount } = event.args;
  // The event has no vote rule: read the snapshot once, at this block (TASK-014a).
  const snapshot = await context.client.readContract({
    abi: EmergencyPoolAbi,
    address: poolAddress,
    functionName: "getAllocation",
    args: [id],
    blockNumber: event.block.number,
  });
  await context.db.insert(allocation).values({
    id,
    poolId,
    campaign: event.args.campaign,
    amount,
    delivered: null,
    reasonHash: event.args.reasonHash,
    yesVotes: 0n,
    noVotes: 0n,
    voteEnd: event.args.voteEnd,
    proposalBlock: event.block.number,
    snapQuorumBps: Number(snapshot.snapQuorumBps),
    snapApprovalBps: Number(snapshot.snapApprovalBps),
    state: "VOTING",
    ...origin(event),
  });
  // The amount is reserved until the allocation is delivered or returned.
  await context.db
    .update(pool, { id: poolId })
    .set((row) => ({ balance: row.balance - amount }));
  // The campaign is bound to a sub-pool only when money is delivered (review L-02, ADR-061).
});

ponder.on("EmergencyPool:AllocationVoted", async ({ event, context }) => {
  const { id, voter, approve, weight } = event.args;
  await context.db
    .insert(allocationVote)
    .values({ allocationId: id, voter, approve, weight, ...origin(event) });
  await context.db.update(allocation, { id }).set((row) => ({
    yesVotes: approve ? row.yesVotes + weight : row.yesVotes,
    noVotes: approve ? row.noVotes : row.noVotes + weight,
  }));
});

ponder.on("EmergencyPool:AllocationClosed", async ({ event, context }) => {
  const { id } = event.args;
  const state = allocationStateName(event.args.state);
  const row = await context.db.find(allocation, { id });
  if (!row) throw new Error(`AllocationClosed for unknown allocation ${id}`);

  // PASSED returns what the campaign did not take; REJECTED returns everything;
  // NEEDS_REVIEW keeps the amount reserved for the guardian.
  let delivered: bigint | null = null;
  let returned = 0n;
  if (state === "PASSED") {
    delivered = await deliveredAmount(context.client, event, row.campaign, id);
    returned = row.amount - delivered;
  } else if (state === "REJECTED") {
    returned = row.amount;
  }

  await context.db.update(allocation, { id }).set({ state, delivered });
  await context.db
    .update(pool, { id: row.poolId })
    .set((p) => ({ balance: p.balance + returned }));
  // Delivered: the campaign is now bound to this sub-pool (EmergencyPool._bindFundingPool, review L-02).
  if (state === "PASSED") {
    await context.db
      .update(campaign, { address: row.campaign })
      .set((c) => ({ fundingPoolId: c.fundingPoolId ?? row.poolId }));
  }
});

ponder.on("EmergencyPool:AllocationDeliveryFailed", async ({ event, context }) => {
  const { id } = event.args;
  const row = await context.db.find(allocation, { id });
  if (!row) throw new Error(`AllocationDeliveryFailed for unknown allocation ${id}`);

  await context.db.update(allocation, { id }).set({ state: "DELIVERY_FAILED" });
  await context.db
    .update(pool, { id: row.poolId })
    .set((p) => ({ balance: p.balance + row.amount }));
});

ponder.on("EmergencyPool:AllocationResolved", async ({ event, context }) => {
  const { id, approve } = event.args;
  const state = allocationStateName(event.args.state);
  const row = await context.db.find(allocation, { id });
  if (!row) throw new Error(`AllocationResolved for unknown allocation ${id}`);

  await context.db.insert(guardianAction).values({
    id: event.id,
    kind: "ALLOCATION_RESOLVE",
    campaign: row.campaign,
    allocationId: id,
    actor: event.transaction.from,
    approve,
    resultState: state,
    ...origin(event),
  });

  let delivered: bigint | null = null;
  let returned = row.amount; // RESOLVED_REJECT
  if (state === "RESOLVED_PASS") {
    delivered = await deliveredAmount(context.client, event, row.campaign, id);
    returned = row.amount - delivered;
  }

  await context.db.update(allocation, { id }).set({ state, delivered });
  await context.db
    .update(pool, { id: row.poolId })
    .set((p) => ({ balance: p.balance + returned }));
  if (state === "RESOLVED_PASS") {
    await context.db
      .update(campaign, { address: row.campaign })
      .set((c) => ({ fundingPoolId: c.fundingPoolId ?? row.poolId }));
  }
});
