/**
 * CLI script and helper: removes a platform admin's second factor (ADR-056),
 * for a lost phone without recovery codes. The admin enrols again at the next
 * visit to an admin page; old MFA cookies stop working (they are bound to the
 * removed enrolment). Audited as `admin.mfa_reset`.
 *
 * Usage:
 *   DATABASE_URL_DIRECT=... pnpm --filter @cherrio/db reset-admin-mfa <address>
 *   or, in the web container:
 *   node packages/db/dist/reset-admin-mfa.mjs <address>
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "./schema/index.js";

export interface ResetAdminMfaResult {
  success: boolean;
  userId?: string;
  message: string;
}

export async function resetAdminMfa(databaseUrl: string, rawAddress: string): Promise<ResetAdminMfaResult> {
  const address = rawAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return {
      success: false,
      message: `Invalid wallet address format: "${rawAddress}". Must be a 42-character 0x-prefixed hex string.`,
    };
  }

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });
  try {
    const [owner] = await db
      .select({ userId: schema.userAddresses.userId })
      .from(schema.userAddresses)
      .where(eq(schema.userAddresses.address, address))
      .limit(1);
    if (!owner) return { success: false, message: "No user has this wallet address." };

    const removed = await db.transaction(async (tx) => {
      const rows = await tx
        .delete(schema.adminMfa)
        .where(eq(schema.adminMfa.userId, owner.userId))
        .returning({ id: schema.adminMfa.id });
      if (rows.length > 0) {
        await tx.insert(schema.auditLog).values({
          actorUserId: null, action: "admin.mfa_reset", entityType: "user", entityId: owner.userId,
        });
      }
      return rows.length;
    });
    if (removed === 0) {
      return { success: true, userId: owner.userId, message: `User ${owner.userId} has no second factor — nothing to reset.` };
    }
    return {
      success: true,
      userId: owner.userId,
      message: `Second factor removed for user ${owner.userId} (${address}). They set up a new one at the next admin page.`,
    };
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/reset-admin-mfa.ts") ||
    process.argv[1].endsWith("/reset-admin-mfa.mjs") ||
    process.argv[1].endsWith("/reset-admin-mfa.js"));

if (isMain) {
  const targetAddress = process.argv[2];
  if (!targetAddress) {
    console.error("Usage: pnpm --filter @cherrio/db reset-admin-mfa <0x-address>");
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("Neither DATABASE_URL_DIRECT nor DATABASE_URL is set.");
    process.exit(1);
  }
  resetAdminMfa(dbUrl, targetAddress)
    .then((result) => {
      (result.success ? console.log : console.error)(result.message);
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error("reset-admin-mfa failed unexpectedly:", err);
      process.exit(1);
    });
}
