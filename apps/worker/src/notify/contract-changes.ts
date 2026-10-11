import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";

// Timelock watcher, admin alert (TASK-023d-3, security review M-02). Every
// operation the indexer saw on the TimelockController (chain.timelock_operation)
// queues one email to every platform admin, whoever scheduled it. The outbox's
// unique (user, kind, dedupe_key) makes it once per admin and operation; the
// key carries the schedule block, so an operation cancelled and scheduled again
// alerts again.
//
// - Every WAITING operation, however old (it can still be applied), and
//   executed or cancelled ones whose execution / cancellation is less than
//   RECENT_SECONDS old: a change applied before the worker saw it (a short
//   test-network delay, a worker outage) still alerts, but a first run or a
//   re-index never mails old history.
// - Only after SETTLE_SECONDS: the admin console records its own operations
//   right after the wallet confirms, so "scheduled from the console" is known
//   by then and a console change is not reported as a stranger's. "From the
//   console" means a console record with the same operation id AND schedule
//   transaction (an operation cancelled and scheduled again by someone else is
//   not the console's).
// - It is a security alert: sent to the admin's address even when campaign
//   emails are switched off, without an unsubscribe link (send.ts).

export const RECENT_SECONDS = 7 * 86_400;
export const SETTLE_SECONDS = 5 * 60;

/** Function selectors (first 4 bytes of keccak256 of the signature; checked in the worker tests). */
export const MONEY_SELECTORS = ["0x1d7ad9d8" /* setEmergencyPool(address) */, "0xf0f44260" /* setTreasury(address) */] as const;
export const ROLE_SELECTORS = [
  "0x2f2ff15d" /* grantRole(bytes32,address) */,
  "0xd547741f" /* revokeRole(bytes32,address) */,
  "0x36568abe" /* renounceRole(bytes32,address) */,
  "0x64d62353" /* updateDelay(uint256) */,
] as const;
/** The other PlatformConfig setters. A call with any selector not listed here is "unknown". */
export const SETTING_SELECTORS = [
  "0x023b1fc9" /* setFeeBps(uint16) */,
  "0xaaad8151" /* setSuccessThresholdBps(uint16) */,
  "0x9e33a38e" /* setVoteWindow(uint32) */,
  "0x0527aab6" /* setQuorumBps(uint16) */,
  "0xe692424f" /* setApprovalBps(uint16) */,
  "0x2d75c9a9" /* setRefundSweepDelay(uint32) */,
  "0x83a6595f" /* setMinDonation(uint256) */,
  "0x687e6172" /* setReleaseDelay(uint32) */,
] as const;

export async function enqueueContractChanges(db: Database, now: bigint): Promise<number> {
  const n = now.toString();
  const money = sql.join(MONEY_SELECTORS.map((s) => sql`${s}`), sql`, `);
  const roles = sql.join(ROLE_SELECTORS.map((s) => sql`${s}`), sql`, `);
  const settings = sql.join(SETTING_SELECTORS.map((s) => sql`${s}`), sql`, `);
  const out = (await db.execute(sql`
    insert into app.notifications (id, user_id, kind, dedupe_key, data)
    select gen_random_uuid(), r.user_id, 'CONTRACT_CHANGE_SCHEDULED'::app.notification_kind,
           'timelock:' || o.id || ':' || o.block_number::text,
           jsonb_build_object(
             'operationId', o.id,
             'calls', o.calls,
             'readyAt', o.ready_at::text,
             'state', o.state::text,
             'fromConsole', exists (select 1 from app.contract_changes cc where cc.operation_id = o.id and cc.schedule_tx_hash = o.tx_hash),
             'risk', case
               when exists (select 1 from chain.timelock_call c where c.op_id = o.id and left(c.data, 10) in (${money})) then 'money'
               when exists (select 1 from chain.timelock_call c where c.op_id = o.id and left(c.data, 10) in (${roles})) then 'roles'
               when exists (select 1 from chain.timelock_call c where c.op_id = o.id and left(c.data, 10) not in (${settings})) then 'unknown'
               else 'setting' end)
    from chain.timelock_operation o
    cross join (select distinct ur.user_id from app.user_roles ur where ur.role = 'PLATFORM_ADMIN') r
    where (o.state::text = 'WAITING'
           or coalesce(o.executed_block_time, o.cancelled_block_time) > ${n}::numeric - ${RECENT_SECONDS})
      and o.block_time <= ${n}::numeric - ${SETTLE_SECONDS}
    on conflict (user_id, kind, dedupe_key) do nothing
    returning id
  `)) as unknown as unknown[];
  return out.length;
}
