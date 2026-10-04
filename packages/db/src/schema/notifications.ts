import { boolean, index, integer, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { appSchema, notificationKindEnum, notificationStatusEnum } from "./enums.js";
import { uuidPk } from "./helpers.js";
import { users } from "./users.js";

// ── notifications (outbox) ────────────────────────────────────────────────────
// TASK-033e, ADR-048: the worker queues one row per (user, kind, event) and
// sends it. Postgres is the queue (FOR UPDATE SKIP LOCKED); no Redis.
// The recipient address is resolved at send time (preferences, then users.email).
// eraseUser() deletes the user's rows.
export const notifications = appSchema.table("notifications", {
  id:        uuidPk(),
  userId:    uuid("user_id").notNull().references(() => users.id),
  kind:      notificationKindEnum("kind").notNull(),
  /** The event, e.g. `vote_opened:<campaign>:<round>`; one row per (user, kind, key). */
  dedupeKey: text("dedupe_key").notNull(),
  /** What the email needs (campaign title, slug, round, …). No secrets once sent. */
  data:      jsonb("data").notNull().default({}),
  status:    notificationStatusEnum("status").notNull().default("PENDING"),
  attempts:  integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  sendAfter: timestamp("send_after", { withTimezone: true }).notNull().defaultNow(),
  sentAt:    timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("notifications_user_kind_key_uniq").on(t.userId, t.kind, t.dedupeKey),
  index("notifications_status_send_after_idx").on(t.status, t.sendAfter),
]);

// ── notification_preferences ──────────────────────────────────────────────────
// One row per user, created on first use. `email_enabled = false` is the
// unsubscribe. `contact_email` is a confirmed address of a wallet-only user
// (double opt-in); it wins over users.email. Tokens are stored as SHA-256 hex.
export const notificationPreferences = appSchema.table("notification_preferences", {
  userId:           uuid("user_id").primaryKey().references(() => users.id),
  emailEnabled:     boolean("email_enabled").notNull().default(true),
  contactEmail:     text("contact_email"),
  pendingEmail:     text("pending_email"),
  confirmTokenHash: text("confirm_token_hash"),
  confirmExpiresAt: timestamp("confirm_expires_at", { withTimezone: true }),
  confirmedAt:      timestamp("confirmed_at", { withTimezone: true }),
  /** Random, URL-safe; the one-click unsubscribe link carries it. */
  unsubscribeToken: text("unsubscribe_token").notNull().unique(),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                      .$onUpdateFn(() => new Date()),
});
