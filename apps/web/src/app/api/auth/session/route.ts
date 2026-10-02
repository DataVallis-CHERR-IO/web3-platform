import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users, userAddresses, userRoles, auditLog } from "@cherrio/db";
import { getPrivyClient } from "@/lib/auth/privy";
import {
  signSessionToken,
  getSession,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import {
  authRateLimiter,
  AUTH_RATE_LIMIT,
  getClientIp,
} from "@/lib/security/rate-limit";
import {
  generateDefaultDisplayName,
  extractWalletsFromPrivyUser,
  extractEmailFromPrivyUser,
} from "@/lib/auth/user-helpers";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const ip = getClientIp(request);

  // 1. Rate limiter check (per-container)
  const rateLimitResult = authRateLimiter.check(ip, AUTH_RATE_LIMIT);
  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "too_many_requests", message: "Too many authentication requests." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimitResult.reset) },
      }
    );
  }

  // 2. Strict Origin check
  if (!verifyOrigin(request)) {
    return NextResponse.json(
      { error: "forbidden", message: "Invalid request origin." },
      { status: 403 }
    );
  }

  let body: { accessToken?: string; locale?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  if (!body.accessToken) {
    return NextResponse.json(
      { error: "bad_request", message: "Missing accessToken." },
      { status: 400 }
    );
  }

  // 3. Verify Privy access token
  const privy = getPrivyClient();
  let verifiedClaims;
  try {
    verifiedClaims = await privy.verifyAuthToken(body.accessToken);
  } catch {
    return NextResponse.json(
      { error: "unauthorized", message: "Invalid or expired Privy access token." },
      { status: 401 }
    );
  }

  // 4. Fetch full Privy user record
  const privyUser = await privy.getUser(verifiedClaims.userId);
  if (!privyUser) {
    return NextResponse.json(
      { error: "unauthorized", message: "Privy user not found." },
      { status: 401 }
    );
  }

  const privyDid = privyUser.id;
  const email = extractEmailFromPrivyUser(privyUser);
  const wallets = extractWalletsFromPrivyUser(privyUser);
  const walletAddresses = wallets.map((w) => w.address);

  const db = getDb();

  // 5. Database transaction for conflict check + user & address upsert
  let userId: string;
  let userRecord: { displayName: string; email: string | null; anonymousDonations: boolean; locale: string };
  let roles: string[] = [];

  try {
    const result = await db.transaction(async (tx) => {
      // (a) Address conflict check across all attached wallets
      if (walletAddresses.length > 0) {
        const existingAddresses = await tx
          .select({
            address: userAddresses.address,
            userId: userAddresses.userId,
            privyDid: users.privyDid,
          })
          .from(userAddresses)
          .innerJoin(users, eq(userAddresses.userId, users.id))
          .where(inArray(userAddresses.address, walletAddresses));

        for (const ea of existingAddresses) {
          // If address is registered to a user with a different Privy DID, conflict!
          if (ea.privyDid !== privyDid) {
            throw new Error("WALLET_CONFLICT");
          }
        }
      }

      // (b) Find or create user
      const [existingUser] = await tx
        .select()
        .from(users)
        .where(eq(users.privyDid, privyDid))
        .limit(1);

      let targetUser: typeof users.$inferSelect;

      if (existingUser) {
        const [updated] = await tx
          .update(users)
          .set({
            email: email ?? existingUser.email,
            locale: body.locale ?? existingUser.locale,
            updatedAt: new Date(),
          })
          .where(eq(users.id, existingUser.id))
          .returning();
        targetUser = updated!;
      } else {
        const [created] = await tx
          .insert(users)
          .values({
            privyDid,
            displayName: generateDefaultDisplayName(),
            email: email ?? null,
            locale: body.locale ?? "en",
            anonymousDonations: false,
          })
          .returning();
        targetUser = created!;
      }

      // (c) Upsert user addresses
      const currentAddresses = await tx
        .select()
        .from(userAddresses)
        .where(eq(userAddresses.userId, targetUser.id));

      const hasPrimary = currentAddresses.some((a) => a.isPrimary);

      for (let i = 0; i < wallets.length; i++) {
        const w = wallets[i]!;
        const alreadyLinked = currentAddresses.find((a) => a.address === w.address);
        const shouldBePrimary = !hasPrimary && i === 0;

        if (!alreadyLinked) {
          await tx
            .insert(userAddresses)
            .values({
              userId: targetUser.id,
              address: w.address,
              kind: w.kind,
              isPrimary: shouldBePrimary,
            })
            .onConflictDoNothing();
        }
      }

      // (d) Read user roles
      const userRoleRows = await tx
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, targetUser.id));

      const userRolesList = userRoleRows.map((r) => r.role);

      // (e) Audit log
      await tx.insert(auditLog).values({
        actorUserId: targetUser.id,
        action: "auth.login",
        entityType: "user",
        entityId: targetUser.id,
        ip,
      });

      return {
        user: targetUser,
        roles: userRolesList,
      };
    });

    userId = result.user.id;
    userRecord = {
      displayName: result.user.displayName,
      email: result.user.email,
      anonymousDonations: result.user.anonymousDonations,
      locale: result.user.locale,
    };
    roles = result.roles;
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
    console.error("Session creation error:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to create session." },
      { status: 500 }
    );
  }

  // 6. Sign app session JWT cookie
  const sessionToken = await signSessionToken({ userId, roles });
  const cookieOpts = getSessionCookieOptions();

  // The same user shape as GET /api/auth/user (the account page reads `addresses`).
  const addresses = await db
    .select({
      id: userAddresses.id,
      address: userAddresses.address,
      kind: userAddresses.kind,
      isPrimary: userAddresses.isPrimary,
    })
    .from(userAddresses)
    .where(eq(userAddresses.userId, userId));

  const response = NextResponse.json({
    user: {
      id: userId,
      ...userRecord,
      roles,
      addresses,
    },
  });

  response.cookies.set({
    name: cookieOpts.name,
    value: sessionToken,
    httpOnly: cookieOpts.httpOnly,
    secure: cookieOpts.secure,
    sameSite: cookieOpts.sameSite,
    path: cookieOpts.path,
    maxAge: cookieOpts.maxAge,
  });

  return response;
}

export async function DELETE(request: Request) {
  if (!verifyOrigin(request)) {
    return NextResponse.json(
      { error: "forbidden", message: "Invalid request origin." },
      { status: 403 }
    );
  }

  const session = await getSession(request);
  const ip = getClientIp(request);

  if (session) {
    const db = getDb();
    await db.insert(auditLog).values({
      actorUserId: session.userId,
      action: "auth.logout",
      entityType: "user",
      entityId: session.userId,
      ip,
    });
  }

  const response = NextResponse.json({ success: true });
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
