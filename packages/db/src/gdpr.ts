import { eq } from "drizzle-orm";
import type { Database } from "./index.js";
import { auditLog, kycChecks, ratings, userAddresses, users } from "./schema/index.js";

/**
 * Hard-erase personal data for a user (GDPR right-to-erasure).
 *
 * Runs in a single transaction:
 * - Nulls email, privy_did, and sets display_name = "Deleted user"
 * - Hard-deletes user_addresses (personal: links person to on-chain address)
 * - Hard-deletes kyc_checks (Sumsub applicant reference)
 * - Nulls audit_log.ip for all rows where actor_user_id = userId
 * - Nulls ratings.signature (EIP-712 signature identifies the signer)
 *
 * Kept pseudonymous by user_id (not deleted):
 *   points_ledger, ratings (content + stars stay for org Trust Score)
 *
 * @param db    A Drizzle Database instance (direct connection, not PgBouncer
 *              transaction-pooled, so the transaction round-trips correctly).
 * @param userId UUID of the user to erase.
 */
export async function eraseUser(db: Database, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Anonymise the user record
    await tx
      .update(users)
      .set({ displayName: "Deleted user", email: null, privyDid: null })
      .where(eq(users.id, userId));

    // 2. Remove address-to-person linkage (personal data per ADR-014)
    await tx.delete(userAddresses).where(eq(userAddresses.userId, userId));

    // 3. Remove KYC check reference (Sumsub applicant ID)
    await tx.delete(kycChecks).where(eq(kycChecks.userId, userId));

    // 4. Strip IP from audit trail for this actor
    await tx
      .update(auditLog)
      .set({ ip: null })
      .where(eq(auditLog.actorUserId, userId));

    // 5. Strip EIP-712 signature from ratings (star + comment kept for Trust Score)
    await tx
      .update(ratings)
      .set({ signature: null })
      .where(eq(ratings.userId, userId));
  });
}
