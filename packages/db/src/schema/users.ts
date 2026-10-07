import { boolean, index, integer, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, addressKindEnum, platformRoleEnum } from "./enums.js";
import { uuidPk } from "./helpers.js";

// ── users ────────────────────────────────────────────────────────────────────
export const users = appSchema.table("users", {
  id:                 uuidPk(),
  displayName:        text("display_name").notNull(),
  email:              text("email"),
  privyDid:           text("privy_did").unique(),
  locale:             varchar("locale", { length: 10 }).notNull().default("en"),
  anonymousDonations: boolean("anonymous_donations").notNull().default(false),
  // Display currency chosen by the user (ADR-040); restored into the cookie at login.
  // ADR-053: synthetic member of a demo organisation (local/dev only); never logs in through Privy.
  isDemo:             boolean("is_demo").notNull().default(false),
  displayCurrency:    varchar("display_currency", { length: 10 }),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                        .$onUpdateFn(() => new Date()),
});

// ── user_addresses ────────────────────────────────────────────────────────────
// Personal data: links a person to an on-chain address. Deleted by eraseUser().
export const userAddresses = appSchema.table("user_addresses", {
  id:        uuidPk(),
  userId:    uuid("user_id").notNull().references(() => users.id),
  address:   varchar("address", { length: 42 }).notNull().unique(),
  kind:      addressKindEnum("kind").notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
               .$onUpdateFn(() => new Date()),
}, (t) => [
  index("user_addresses_user_id_idx").on(t.userId),
  check("user_addresses_address_format", sql`${t.address} ~ '^0x[0-9a-f]{40}$'`),
]);

// ── user_roles ────────────────────────────────────────────────────────────────
// Platform-level roles only (ADR: org membership lives in org_members).
// PLATFORM_ADMIN is the only role; org_id removed from this table.
export const userRoles = appSchema.table("user_roles", {
  id:        uuidPk(),
  userId:    uuid("user_id").notNull().references(() => users.id),
  role:      platformRoleEnum("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
               .$onUpdateFn(() => new Date()),
}, (t) => [
  index("user_roles_user_id_idx").on(t.userId),
  unique("user_roles_user_id_role_uniq").on(t.userId, t.role),
]);

// ── admin_mfa ─────────────────────────────────────────────────────────────────
// ADR-056: a PLATFORM_ADMIN's second factor (TOTP). One row per user; a new
// enrolment replaces an unconfirmed row and gets a new id (the MFA cookie is
// bound to it). The secret is AES-256-GCM ciphertext (key derived from
// SESSION_SECRET); recovery codes are SHA-256 hashes. Deleted by eraseUser().
export const adminMfa = appSchema.table("admin_mfa", {
  id:                 uuidPk(),
  userId:             uuid("user_id").notNull().references(() => users.id).unique(),
  secretEnc:          text("secret_enc").notNull(),
  /** Null while the enrolment waits for its first code. */
  confirmedAt:        timestamp("confirmed_at", { withTimezone: true }),
  /** Last accepted TOTP time step (unix time / 30); a code is accepted once. */
  lastUsedStep:       integer("last_used_step"),
  recoveryCodeHashes: text("recovery_code_hashes").array().notNull().default(sql`'{}'::text[]`),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                        .$onUpdateFn(() => new Date()),
});
