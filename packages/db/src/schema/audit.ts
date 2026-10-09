import { index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "./enums.js";
import { uuidPk } from "./helpers.js";
import { users } from "./users.js";

// ── audit_log ─────────────────────────────────────────────────────────────────
// Append-only. ip is nulled by eraseUser() for GDPR compliance.
export const auditLog = appSchema.table("audit_log", {
  id:          uuidPk(),
  /** Null for system-initiated actions. */
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action:      text("action").notNull(),
  entityType:  text("entity_type").notNull(),
  entityId:    uuid("entity_id"),
  data:        jsonb("data"),
  /** Nulled by eraseUser() for GDPR. */
  ip:          text("ip"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("audit_log_actor_user_id_idx").on(t.actorUserId),
  index("audit_log_entity_type_entity_id_idx").on(t.entityType, t.entityId),
  // TASK-021: Admin → Audit log pages newest first by (created_at, id).
  index("audit_log_created_at_id_idx").on(t.createdAt, t.id),
]);
