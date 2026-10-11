import { ponder } from "ponder:registry";
import { timelockCall, timelockOperation } from "ponder:schema";
import { origin } from "../lib/origin";

// TASK-023d (review M-02): every operation on the TimelockController. One
// CallScheduled per call of a batch, in index order, then CallSalt when the salt
// is not zero. Executing a batch emits one CallExecuted per call; Cancelled once.

ponder.on("Timelock:CallScheduled", async ({ event, context }) => {
  const { id, index, target, value, data, predecessor, delay } = event.args;
  const scheduled = {
    calls: Number(index) + 1,
    predecessor,
    salt: null,
    delay,
    readyAt: event.block.timestamp + delay,
    state: "WAITING" as const,
    executedTxHash: null,
    executedBlockTime: null,
    cancelledTxHash: null,
    cancelledBlockTime: null,
    ...origin(event),
  };
  if (index === 0n) {
    // A cancelled operation can be scheduled again with the same id: start over.
    await context.db.insert(timelockOperation).values({ id, ...scheduled }).onConflictDoUpdate(scheduled);
  } else {
    await context.db.update(timelockOperation, { id }).set({ calls: Number(index) + 1 });
  }
  const call = { target, value, data };
  await context.db
    .insert(timelockCall)
    .values({ opId: id, index: Number(index), ...call })
    .onConflictDoUpdate(call);
});

ponder.on("Timelock:CallSalt", async ({ event, context }) => {
  await context.db.update(timelockOperation, { id: event.args.id }).set({ salt: event.args.salt });
});

ponder.on("Timelock:CallExecuted", async ({ event, context }) => {
  // The whole batch executes in one transaction; every call sets the same values.
  await context.db.update(timelockOperation, { id: event.args.id }).set({
    state: "EXECUTED",
    executedTxHash: event.transaction.hash,
    executedBlockTime: event.block.timestamp,
  });
});

ponder.on("Timelock:Cancelled", async ({ event, context }) => {
  await context.db.update(timelockOperation, { id: event.args.id }).set({
    state: "CANCELLED",
    cancelledTxHash: event.transaction.hash,
    cancelledBlockTime: event.block.timestamp,
  });
});
