import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, getDirectDb } from "@/lib/db";
import { users, auditLog, eraseUser } from "@cherrio/db";
import { getPrivyClient } from "@/lib/auth/privy";
import { getSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { removeStoredObject } from "@/lib/files/storage";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/auth/account
 * GDPR Right-to-Erasure workflow.
 *
 * Execution order:
 * 1. eraseUser(db, userId) in a database transaction; then the objects of the
 *    private files it marked deleted are removed from storage (ADR-034)
 * 2. Privy server-side user deletion (deleteUser)
 * 3. If Privy deletion fails: write audit_log "account.privy_delete_failed",
 *    log warning, clear session, return success to user.
 * 4. If Privy deletion succeeds: write audit_log "account.deleted",
 *    clear session, return success to user.
 */
export async function DELETE(request: Request) {
  if (!verifyOrigin(request)) {
    return NextResponse.json(
      { error: "forbidden", message: "Invalid request origin." },
      { status: 403 }
    );
  }

  const session = await getSession(request);
  if (!session) {
    return NextResponse.json(
      { error: "unauthorized", message: "Authentication required." },
      { status: 401 }
    );
  }

  const userId = session.userId;
  const db = getDb();
  const directDb = getDirectDb();

  // Find user to obtain privyDid before erasing
  const [user] = await db
    .select({ id: users.id, privyDid: users.privyDid })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const privyDid = user?.privyDid;

  // Step 1: Hard erase personal data from DB (GDPR)
  let storageKeys: string[];
  try {
    ({ storageKeys } = await eraseUser(directDb, userId));
  } catch (err) {
    console.error("Failed to erase user from database:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to erase account data." },
      { status: 500 }
    );
  }

  // Step 1b: the rows of the user's private files are marked deleted; now that
  // the transaction is committed, delete the objects. A failure is logged
  // (no key, no personal data) and the object is left for `files:sweep`.
  for (const storageKey of storageKeys) {
    await removeStoredObject(storageKey);
  }

  // Step 2: Delete user from Privy
  if (privyDid) {
    try {
      const privy = getPrivyClient();
      await privy.deleteUser(privyDid);

      await db.insert(auditLog).values({
        action: "account.deleted",
        entityType: "user",
        entityId: userId,
      });
    } catch (privyErr) {
      console.warn(`[Auth] Privy deleteUser failed for user ${userId}:`, privyErr);
      await db.insert(auditLog).values({
        action: "account.privy_delete_failed",
        entityType: "user",
        entityId: userId,
      });
    }
  } else {
    await db.insert(auditLog).values({
      action: "account.deleted",
      entityType: "user",
      entityId: userId,
    });
  }

  // Step 3: Clear session cookie on response
  const response = NextResponse.json({
    success: true,
    message: "Account erased successfully.",
  });
  response.cookies.delete(SESSION_COOKIE_NAME);

  return response;
}
