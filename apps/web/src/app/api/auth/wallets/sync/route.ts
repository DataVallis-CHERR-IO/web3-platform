import { NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users, userAddresses, auditLog } from "@cherrio/db";
import { getPrivyClient } from "@/lib/auth/privy";
import { getSession } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { getClientIp } from "@/lib/security/rate-limit";
import { extractWalletsFromPrivyUser } from "@/lib/auth/user-helpers";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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

  const db = getDb();
  const [user] = await db
    .select({ id: users.id, privyDid: users.privyDid })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user || !user.privyDid) {
    return NextResponse.json(
      { error: "bad_request", message: "User account has no linked Privy identity." },
      { status: 400 }
    );
  }

  // 1. Fetch latest Privy record server-side
  const privy = getPrivyClient();
  const privyUser = await privy.getUser(user.privyDid);
  if (!privyUser) {
    return NextResponse.json(
      { error: "internal_error", message: "Could not retrieve user from Privy." },
      { status: 500 }
    );
  }

  const privyWallets = extractWalletsFromPrivyUser(privyUser);
  const privyAddresses = privyWallets.map((w) => w.address);
  const ip = getClientIp(request);

  // 2. Reconcile user_addresses in a transaction
  try {
    const finalAddresses = await db.transaction(async (tx) => {
      // (a) Check if any new address belongs to a different user
      if (privyAddresses.length > 0) {
        const conflicts = await tx
          .select({
            address: userAddresses.address,
            userId: userAddresses.userId,
            privyDid: users.privyDid,
          })
          .from(userAddresses)
          .innerJoin(users, eq(userAddresses.userId, users.id))
          .where(inArray(userAddresses.address, privyAddresses));

        for (const c of conflicts) {
          if (c.userId !== user.id) {
            throw new Error("WALLET_CONFLICT");
          }
        }
      }

      // (b) Current DB addresses
      const current = await tx
        .select()
        .from(userAddresses)
        .where(eq(userAddresses.userId, user.id));

      const currentAddressMap = new Map(current.map((a) => [a.address, a]));

      // (c) Delete removed addresses
      const removed = current.filter((a) => !privyAddresses.includes(a.address));
      if (removed.length > 0) {
        const removedAddrs = removed.map((a) => a.address);
        await tx
          .delete(userAddresses)
          .where(
            and(
              eq(userAddresses.userId, user.id),
              inArray(userAddresses.address, removedAddrs)
            )
          );
      }

      // (d) Insert newly linked addresses
      for (const pw of privyWallets) {
        if (!currentAddressMap.has(pw.address)) {
          await tx
            .insert(userAddresses)
            .values({
              userId: user.id,
              address: pw.address,
              kind: pw.kind,
              isPrimary: false,
            })
            .onConflictDoNothing();
        }
      }

      // (e) Ensure primary address exists
      const remaining = await tx
        .select()
        .from(userAddresses)
        .where(eq(userAddresses.userId, user.id));

      const hasPrimary = remaining.some((a) => a.isPrimary);
      if (!hasPrimary && remaining.length > 0) {
        const first = remaining[0]!;
        await tx
          .update(userAddresses)
          .set({ isPrimary: true, updatedAt: new Date() })
          .where(eq(userAddresses.id, first.id));
        first.isPrimary = true;
      }

      // (f) Audit log
      await tx.insert(auditLog).values({
        actorUserId: user.id,
        action: "wallets.synced",
        entityType: "user",
        entityId: user.id,
        ip,
      });

      return tx
        .select()
        .from(userAddresses)
        .where(eq(userAddresses.userId, user.id));
    });

    return NextResponse.json({ addresses: finalAddresses });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "WALLET_CONFLICT") {
      return NextResponse.json(
        {
          error: "wallet_conflict",
          message: "This wallet is already linked to another account.",
        },
        { status: 409 }
      );
    }
    console.error("Wallet sync error:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to sync wallets." },
      { status: 500 }
    );
  }
}
