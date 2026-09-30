import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appSchema, kycStatusEnum } from "./enums.js";
import { uuidPk } from "./helpers.js";
import { users } from "./users.js";

// ── kyc_checks ────────────────────────────────────────────────────────────────
// Sumsub applicant status only. No document data stored (ADR-014, GDPR).
// Rows are hard-deleted by eraseUser().
export const kycChecks = appSchema.table("kyc_checks", {
  id:          uuidPk(),
  userId:      uuid("user_id").notNull().references(() => users.id),
  /** Always "SUMSUB" in Phase 1; kept as text for future extensibility. */
  provider:    text("provider").notNull().default("SUMSUB"),
  applicantId: text("applicant_id").notNull(),
  status:      kycStatusEnum("status").notNull().default("INITIATED"),
  /** Sumsub verification level name (e.g. "basic-kyc-level"). */
  level:       text("level"),
  reviewedAt:  timestamp("reviewed_at", { withTimezone: true }),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                 .$onUpdateFn(() => new Date()),
}, (t) => [
  index("kyc_checks_user_id_idx").on(t.userId),
]);
