interface EventLike {
  block: { number: bigint; timestamp: bigint };
  transaction: { hash: `0x${string}` };
  log: { logIndex: number };
}

/** The event columns every row carries: where it came from on chain. */
export function origin(event: EventLike) {
  return {
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    blockNumber: event.block.number,
    blockTime: event.block.timestamp,
  };
}
