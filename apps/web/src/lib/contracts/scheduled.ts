import { sql } from "drizzle-orm";
import { decodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import type { Database } from "@cherrio/db";
import { isMissingRelation } from "@/lib/campaigns/publish";
import { decodeSetter, rawToString, type ConfigKey } from "./config-params";
import type { ConsoleContracts } from "./changes";

// Timelock watcher, public side (TASK-023d-2, security review M-02).
// Every operation the indexer saw on the TimelockController (`chain.timelock_operation`,
// `chain.timelock_call`), whoever scheduled it, described in plain terms. Calls that
// change where money goes (`setEmergencyPool`, `setTreasury`) or who holds a role are
// marked, and anything that is not a known call is shown as unknown — never hidden.

/** Calls the timelock may make that are not PlatformConfig setters. */
const OtherCallsAbi = parseAbi([
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function updateDelay(uint256 newDelay)",
]);

const ROLE_NAMES = ["OPERATOR_ROLE", "GUARDIAN_ROLE", "PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE"] as const;
export type RoleName = (typeof ROLE_NAMES)[number] | "DEFAULT_ADMIN_ROLE";

/** OpenZeppelin AccessControl role ids: keccak256 of the name; the admin role is zero. */
const ROLE_BY_HASH = new Map<string, RoleName>([
  [`0x${"0".repeat(64)}`, "DEFAULT_ADMIN_ROLE"],
  ...ROLE_NAMES.map((name) => [keccak256(toHex(name)), name] as [string, RoleName]),
]);

export type CallView =
  | { kind: "setting"; key: ConfigKey; to: string }
  | { kind: "role"; action: "grant" | "revoke"; role: RoleName | null; roleId: Hex; account: Address; on: "platformConfig" | "timelock" }
  | { kind: "delay"; seconds: bigint }
  | { kind: "unknown"; target: Address; selector: string };

/** What a scheduled change could do, worst first. */
export type CallRisk = "money" | "roles" | "unknown" | "setting";

const MONEY_KEYS: readonly ConfigKey[] = ["emergencyPool", "treasury"];

export function callRisk(call: CallView): CallRisk {
  if (call.kind === "setting") return MONEY_KEYS.includes(call.key) ? "money" : "setting";
  if (call.kind === "role") return "roles";
  if (call.kind === "delay") return "roles"; // a shorter delay weakens the watch itself
  return "unknown";
}

/** One call of an operation in plain terms. Unknown targets or selectors stay unknown. */
export function describeCall(target: string, data: Hex, contracts: Pick<ConsoleContracts, "platformConfig" | "timelock">): CallView {
  const to = getAddress(target);
  const on = to === contracts.platformConfig ? "platformConfig" : to === contracts.timelock ? "timelock" : null;
  if (on === "platformConfig") {
    const setter = decodeSetter(data);
    if (setter) return { kind: "setting", key: setter.spec.key, to: rawToString(setter.value) };
  }
  if (on) {
    try {
      const decoded = decodeFunctionData({ abi: OtherCallsAbi, data });
      if (decoded.functionName === "updateDelay" && on === "timelock") {
        return { kind: "delay", seconds: decoded.args[0] };
      }
      if (decoded.functionName === "grantRole" || decoded.functionName === "revokeRole") {
        const [roleId, account] = decoded.args;
        return {
          kind: "role",
          action: decoded.functionName === "grantRole" ? "grant" : "revoke",
          role: ROLE_BY_HASH.get(roleId.toLowerCase()) ?? null,
          roleId,
          account: getAddress(account),
          on,
        };
      }
    } catch {
      // not one of these calls: unknown below
    }
  }
  return { kind: "unknown", target: to, selector: data.slice(0, 10).toLowerCase() };
}

export type ChangePhase = "waiting" | "ready" | "executed" | "cancelled";

export interface ScheduledChange {
  id: Hex;
  phase: ChangePhase;
  /** When it can be executed (WAITING); for executed/cancelled the time it would have been ready. */
  readyAt: Date;
  scheduledAt: Date;
  scheduleTxHash: Hex;
  executedAt: Date | null;
  executeTxHash: Hex | null;
  cancelledAt: Date | null;
  cancelTxHash: Hex | null;
  calls: CallView[];
  /** Worst risk of its calls. */
  risk: CallRisk;
  /** Recorded by Admin → Contracts (app.contract_changes); false = scheduled some other way. */
  fromConsole: boolean;
}

const RISK_ORDER: readonly CallRisk[] = ["money", "roles", "unknown", "setting"];

export function worstRisk(calls: CallView[]): CallRisk {
  const risks = calls.map(callRisk);
  return RISK_ORDER.find((r) => risks.includes(r)) ?? "setting";
}

export function changePhase(state: string, readyAt: Date, now: Date): ChangePhase {
  if (state === "EXECUTED") return "executed";
  if (state === "CANCELLED") return "cancelled";
  return readyAt.getTime() <= now.getTime() ? "ready" : "waiting";
}

interface Row {
  id: string;
  state: string;
  ready_at: string;
  block_time: string;
  tx_hash: string;
  executed_tx_hash: string | null;
  executed_block_time: string | null;
  cancelled_tx_hash: string | null;
  cancelled_block_time: string | null;
  calls: { target: string; data: string }[] | null;
  from_console: boolean;
}

const fromUnix = (s: string) => new Date(Number(s) * 1000);

/**
 * Newest first. Null while the indexer views are missing (a deploy) — the page
 * then says the list is unavailable instead of claiming there is nothing.
 */
export async function loadScheduledChanges(
  db: Database,
  contracts: Pick<ConsoleContracts, "platformConfig" | "timelock">,
  opts: { now?: Date; limit?: number; pendingOnly?: boolean } = {}
): Promise<ScheduledChange[] | null> {
  const now = opts.now ?? new Date();
  let rows: Row[];
  try {
    rows = (await db.execute(sql`
      select o.id, o.state::text as state, o.ready_at::text as ready_at, o.block_time::text as block_time, o.tx_hash,
        o.executed_tx_hash, o.executed_block_time::text as executed_block_time,
        o.cancelled_tx_hash, o.cancelled_block_time::text as cancelled_block_time,
        (select json_agg(json_build_object('target', c.target, 'data', c.data) order by c.index)
           from chain.timelock_call c where c.op_id = o.id) as calls,
        exists (select 1 from app.contract_changes cc where cc.operation_id = o.id) as from_console
      from chain.timelock_operation o
      where ${opts.pendingOnly ? sql`o.state = 'WAITING'` : sql`true`}
      order by o.block_number desc, o.log_index desc
      limit ${opts.limit ?? 50}
    `)) as unknown as Row[];
  } catch (e) {
    if (isMissingRelation(e)) return null;
    throw e;
  }
  return rows.map((r) => {
    const calls = (r.calls ?? []).map((c) => describeCall(c.target, c.data as Hex, contracts));
    const readyAt = fromUnix(r.ready_at);
    return {
      id: r.id as Hex,
      phase: changePhase(r.state, readyAt, now),
      readyAt,
      scheduledAt: fromUnix(r.block_time),
      scheduleTxHash: r.tx_hash as Hex,
      executedAt: r.executed_block_time ? fromUnix(r.executed_block_time) : null,
      executeTxHash: (r.executed_tx_hash as Hex | null) ?? null,
      cancelledAt: r.cancelled_block_time ? fromUnix(r.cancelled_block_time) : null,
      cancelTxHash: (r.cancelled_tx_hash as Hex | null) ?? null,
      calls,
      risk: worstRisk(calls),
      fromConsole: r.from_console,
    };
  });
}

/**
 * Waiting or ready changes that would move where money goes — the Emergency Pool
 * page notice. Reads every not-yet-executed operation, however old.
 */
export async function pendingMoneyChanges(
  db: Database,
  contracts: Pick<ConsoleContracts, "platformConfig" | "timelock">,
  now?: Date
): Promise<ScheduledChange[]> {
  const pending = await loadScheduledChanges(db, contracts, { now, limit: 500, pendingOnly: true });
  return (pending ?? []).filter((c) => c.risk === "money");
}
