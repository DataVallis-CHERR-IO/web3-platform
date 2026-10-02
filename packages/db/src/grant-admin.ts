/**
 * CLI script and helper to grant the PLATFORM_ADMIN role to a registered user by wallet address.
 *
 * Rule: Must NOT create placeholder users or addresses.
 * If no user owns the address yet, exits with code 1 and error message:
 * "User has not logged in yet — log in with this wallet first, then rerun."
 *
 * Usage:
 *   DATABASE_URL_DIRECT=... pnpm --filter @cherrio/db grant-admin <address>
 *   or:
 *   node packages/db/dist/grant-admin.mjs <address>
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "./schema/index.js";

export interface GrantAdminResult {
  success: boolean;
  userId?: string;
  message: string;
}

export async function grantAdmin(
  databaseUrl: string,
  rawAddress: string
): Promise<GrantAdminResult> {
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
    const [existingAddress] = await db
      .select({ userId: schema.userAddresses.userId })
      .from(schema.userAddresses)
      .where(eq(schema.userAddresses.address, address))
      .limit(1);

    if (!existingAddress) {
      return {
        success: false,
        message: "User has not logged in yet — log in with this wallet first, then rerun.",
      };
    }

    await db
      .insert(schema.userRoles)
      .values({
        userId: existingAddress.userId,
        role: "PLATFORM_ADMIN",
      })
      .onConflictDoNothing({
        target: [schema.userRoles.userId, schema.userRoles.role],
      });

    return {
      success: true,
      userId: existingAddress.userId,
      message: `Granted PLATFORM_ADMIN role to user ${existingAddress.userId} (${address}).`,
    };
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  // By file name only: this module is also bundled into other scripts
  // (apps/web/dist/files.mjs), where import.meta.url is the bundle itself.
  (process.argv[1].endsWith("/grant-admin.ts") ||
    process.argv[1].endsWith("/grant-admin.mjs") ||
    process.argv[1].endsWith("/grant-admin.js"));

if (isMain) {
  const targetAddress = process.argv[2];
  if (!targetAddress) {
    console.error("Usage: pnpm --filter @cherrio/db grant-admin <0x-address>");
    process.exit(1);
  }

  const dbUrl =
    process.env.DATABASE_URL_DIRECT ??
    process.env.DATABASE_URL;

  if (!dbUrl) {
    console.error("Neither DATABASE_URL_DIRECT nor DATABASE_URL is set.");
    process.exit(1);
  }

  grantAdmin(dbUrl, targetAddress)
    .then((result) => {
      if (result.success) {
        console.log(result.message);
        process.exit(0);
      } else {
        console.error(result.message);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("grant-admin failed unexpectedly:", err);
      process.exit(1);
    });
}
