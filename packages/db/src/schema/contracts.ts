import { check, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema } from "./enums.js";
import { uuidPk } from "./helpers.js";
import { users } from "./users.js";

// ── contract_changes ─────────────────────────────────────────────────────────
// PlatformConfig changes scheduled through the TimelockController from the
// admin console (TASK-034, ADR-046). The chain is the source of truth for the
// state of an operation (getOperationState); this row is the record of who
// scheduled, executed or cancelled what. `summary` holds the human-readable
// "old → new" lines shown in the console. No personal data beyond the admin ids.
export const contractChanges = appSchema.table("contract_changes", {
  id:              uuidPk(),
  chainId:         integer("chain_id").notNull(),
  /** Lower-case address of the TimelockController. */
  timelock:        text("timelock").notNull(),
  /** keccak256(abi.encode(targets, values, payloads, predecessor, salt)) — 0x + 64 hex. */
  operationId:     text("operation_id").notNull().unique(),
  /** Lower-case target addresses (always the PlatformConfig today). */
  targets:         text("targets").array().notNull(),
  /** ABI-encoded setter calls, 0x hex. Values are always 0. */
  payloads:        text("payloads").array().notNull(),
  predecessor:     text("predecessor").notNull(),
  salt:            text("salt").notNull(),
  delaySeconds:    integer("delay_seconds").notNull(),
  summary:         jsonb("summary").notNull(),
  scheduledBy:     uuid("scheduled_by").notNull().references(() => users.id),
  scheduleTxHash:  text("schedule_tx_hash").notNull(),
  scheduledAt:     timestamp("scheduled_at", { withTimezone: true }).notNull().defaultNow(),
  executedBy:      uuid("executed_by").references(() => users.id),
  executeTxHash:   text("execute_tx_hash"),
  executedAt:      timestamp("executed_at", { withTimezone: true }),
  cancelledBy:     uuid("cancelled_by").references(() => users.id),
  cancelTxHash:    text("cancel_tx_hash"),
  cancelledAt:     timestamp("cancelled_at", { withTimezone: true }),
}, (t) => [
  index("contract_changes_scheduled_at_idx").on(t.scheduledAt),
  check("contract_changes_operation_id", sql`${t.operationId} ~ '^0x[0-9a-f]{64}$'`),
  check("contract_changes_timelock", sql`${t.timelock} ~ '^0x[0-9a-f]{40}$'`),
  check("contract_changes_lengths", sql`cardinality(${t.targets}) = cardinality(${t.payloads}) and cardinality(${t.targets}) > 0`),
  check("contract_changes_not_both", sql`not (${t.executedAt} is not null and ${t.cancelledAt} is not null)`),
]);
