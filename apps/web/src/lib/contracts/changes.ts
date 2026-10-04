import { desc, eq } from "drizzle-orm";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { auditLog, contractChanges, type Database } from "@cherrio/db";
import { getChainConfig, parseAppEnv } from "@cherrio/shared";
import { decodeSetter, rawToString, type ConfigKey } from "./config-params";
import { operationId } from "./timelock";

// Record of PlatformConfig changes scheduled through the timelock from the admin
// console (TASK-034a, ADR-046). The browser signs; the server only records, after
// recomputing the operation id and checking that every call is a known
// PlatformConfig setter with an in-bounds value. Every write is audited.

export type ContractChangeErrorCode =
  | "not_configured"
  | "validation_failed"
  | "wrong_chain"
  | "wrong_timelock"
  | "foreign_target"
  | "unknown_call"
  | "operation_mismatch"
  | "duplicate"
  | "not_found"
  | "already_closed";

export class ContractChangeError extends Error {
  constructor(public readonly code: ContractChangeErrorCode) {
    super(code);
    this.name = "ContractChangeError";
  }
}

/** Contracts of the current environment the console may act on. */
export interface ConsoleContracts {
  chainId: number;
  timelock: Address;
  platformConfig: Address;
}

/** From the deployment of APP_ENV; null where there is none (local). */
export function consoleContracts(appEnv = process.env.APP_ENV): ConsoleContracts | null {
  const config = getChainConfig(parseAppEnv(appEnv));
  const timelock = config.contracts?.timelockController?.address;
  const platformConfig = config.contracts?.platformConfig?.address;
  if (!timelock || !platformConfig) return null;
  return { chainId: config.chain.id, timelock, platformConfig };
}

export interface ScheduledInput {
  chainId: number;
  timelock: string;
  operationId: string;
  targets: string[];
  payloads: string[];
  predecessor: string;
  salt: string;
  delaySeconds: number;
  /** Value before the change per parameter, as shown in the console (informational). */
  previous: Partial<Record<ConfigKey, string>>;
  txHash: string;
}

/** One line of a change: parameter, value before (as the console read it), value after (from the payload). */
export interface ChangeLine {
  key: ConfigKey;
  from: string | null;
  to: string;
}

export interface ContractChangeView {
  id: string;
  chainId: number;
  timelock: string;
  operationId: string;
  targets: string[];
  payloads: string[];
  predecessor: string;
  salt: string;
  delaySeconds: number;
  lines: ChangeLine[];
  scheduledBy: string;
  scheduleTxHash: string;
  scheduledAt: string;
  executeTxHash: string | null;
  executedAt: string | null;
  cancelTxHash: string | null;
  cancelledAt: string | null;
}

const isBytes32 = (v: string) => /^0x[0-9a-fA-F]{64}$/.test(v);

/**
 * Checks a scheduled operation against the environment's contracts and returns
 * its human summary. Throws ContractChangeError on anything unexpected.
 */
export function verifyScheduled(input: ScheduledInput, contracts: ConsoleContracts): ChangeLine[] {
  if (input.chainId !== contracts.chainId) throw new ContractChangeError("wrong_chain");
  if (!isAddress(input.timelock, { strict: false }) || getAddress(input.timelock) !== contracts.timelock) {
    throw new ContractChangeError("wrong_timelock");
  }
  if (
    input.targets.length === 0 || input.targets.length > 10 || input.targets.length !== input.payloads.length ||
    !isBytes32(input.operationId) || !isBytes32(input.predecessor) || !isBytes32(input.salt) || !isBytes32(input.txHash) ||
    !Number.isInteger(input.delaySeconds) || input.delaySeconds < 0
  ) {
    throw new ContractChangeError("validation_failed");
  }
  const lines: ChangeLine[] = [];
  const seen = new Set<ConfigKey>();
  input.targets.forEach((target, i) => {
    if (!isAddress(target, { strict: false }) || getAddress(target) !== contracts.platformConfig) {
      throw new ContractChangeError("foreign_target");
    }
    const payload = input.payloads[i]!;
    const decoded = isHex(payload) ? decodeSetter(payload) : null;
    if (!decoded || seen.has(decoded.spec.key)) throw new ContractChangeError("unknown_call");
    seen.add(decoded.spec.key);
    lines.push({ key: decoded.spec.key, from: input.previous[decoded.spec.key] ?? null, to: rawToString(decoded.value) });
  });
  const expected = operationId({
    targets: input.targets.map((t) => getAddress(t)),
    payloads: input.payloads as Hex[],
    predecessor: input.predecessor as Hex,
    salt: input.salt as Hex,
  });
  if (expected.toLowerCase() !== input.operationId.toLowerCase()) throw new ContractChangeError("operation_mismatch");
  return lines;
}

export async function recordScheduled(
  db: Database,
  adminId: string,
  input: ScheduledInput,
  contracts: ConsoleContracts,
  ip?: string
): Promise<{ id: string }> {
  const lines = verifyScheduled(input, contracts);
  const opId = input.operationId.toLowerCase();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: contractChanges.id }).from(contractChanges).where(eq(contractChanges.operationId, opId));
    if (existing) throw new ContractChangeError("duplicate");
    const [row] = await tx
      .insert(contractChanges)
      .values({
        chainId: input.chainId,
        timelock: input.timelock.toLowerCase(),
        operationId: opId,
        targets: input.targets.map((t) => t.toLowerCase()),
        payloads: input.payloads.map((p) => p.toLowerCase()),
        predecessor: input.predecessor.toLowerCase(),
        salt: input.salt.toLowerCase(),
        delaySeconds: input.delaySeconds,
        summary: lines,
        scheduledBy: adminId,
        scheduleTxHash: input.txHash.toLowerCase(),
      })
      .returning({ id: contractChanges.id });
    await tx.insert(auditLog).values({
      actorUserId: adminId,
      action: "contracts.change_scheduled",
      entityType: "contract_change",
      entityId: row!.id,
      data: { operationId: opId, txHash: input.txHash.toLowerCase(), lines },
      ip,
    });
    return { id: row!.id };
  });
}

/** Marks a change executed or cancelled (after the admin's transaction was sent). */
export async function recordClosed(
  db: Database,
  adminId: string,
  id: string,
  kind: "executed" | "cancelled",
  txHash: string,
  ip?: string
): Promise<{ id: string }> {
  if (!isBytes32(txHash)) throw new ContractChangeError("validation_failed");
  const hash = txHash.toLowerCase();
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(contractChanges).where(eq(contractChanges.id, id)).for("update");
    if (!row) throw new ContractChangeError("not_found");
    if (row.executedAt || row.cancelledAt) throw new ContractChangeError("already_closed");
    const now = new Date();
    await tx
      .update(contractChanges)
      .set(
        kind === "executed"
          ? { executedBy: adminId, executeTxHash: hash, executedAt: now }
          : { cancelledBy: adminId, cancelTxHash: hash, cancelledAt: now }
      )
      .where(eq(contractChanges.id, id));
    await tx.insert(auditLog).values({
      actorUserId: adminId,
      action: kind === "executed" ? "contracts.change_executed" : "contracts.change_cancelled",
      entityType: "contract_change",
      entityId: id,
      data: { operationId: row.operationId, txHash: hash },
      ip,
    });
    return { id };
  });
}

/** Newest first. */
export async function listChanges(db: Database, limit = 50): Promise<ContractChangeView[]> {
  const rows = await db.select().from(contractChanges).orderBy(desc(contractChanges.scheduledAt)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    chainId: r.chainId,
    timelock: r.timelock,
    operationId: r.operationId,
    targets: r.targets,
    payloads: r.payloads,
    predecessor: r.predecessor,
    salt: r.salt,
    delaySeconds: r.delaySeconds,
    lines: r.summary as ChangeLine[],
    scheduledBy: r.scheduledBy,
    scheduleTxHash: r.scheduleTxHash,
    scheduledAt: r.scheduledAt.toISOString(),
    executeTxHash: r.executeTxHash,
    executedAt: r.executedAt?.toISOString() ?? null,
    cancelTxHash: r.cancelTxHash,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
  }));
}
