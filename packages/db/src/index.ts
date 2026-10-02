import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export * from "./schema/index.js";
export { eraseUser, type EraseUserResult } from "./gdpr.js";
export { grantAdmin, type GrantAdminResult } from "./grant-admin.js";

interface CreateDbOpts {
  /** Connection pool size. Defaults to 10. */
  max?: number;
}

/**
 * Create a typed Drizzle client bound to the given Postgres connection URL.
 *
 * App code should pass DATABASE_URL (PgBouncer transaction-mode URL).
 * `prepare: false` is required for PgBouncer transaction mode — prepared
 * statements are session-scoped and not supported across pooled connections.
 *
 * Migrations and seed scripts must use DATABASE_URL_DIRECT (direct Postgres
 * URL, bypassing PgBouncer) because they need session-level features such as
 * advisory locks. They instantiate their own postgres() client internally.
 */
export function createDb(connectionString: string, opts?: CreateDbOpts) {
  const client = postgres(connectionString, {
    prepare: false,
    max: opts?.max ?? 10,
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

/** Inferred insert/select types for every table */
export type NewUser            = typeof schema.users.$inferInsert;
export type User               = typeof schema.users.$inferSelect;
export type NewUserAddress     = typeof schema.userAddresses.$inferInsert;
export type NewOrganization    = typeof schema.organizations.$inferInsert;
export type Organization       = typeof schema.organizations.$inferSelect;
export type NewCampaign        = typeof schema.campaigns.$inferInsert;
export type Campaign           = typeof schema.campaigns.$inferSelect;
export type NewPointsLedger    = typeof schema.pointsLedger.$inferInsert;
export type NewAuditLog        = typeof schema.auditLog.$inferInsert;
export type NewOnrampOrder     = typeof schema.onrampOrders.$inferInsert;
export type NewEmergencySubpool = typeof schema.emergencySubpools.$inferInsert;
