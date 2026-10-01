import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { users, userAddresses, userRoles, auditLog } from "@cherrio/db";
import { getSession } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const UpdateUserSchema = z.object({
  displayName: z.string().trim().min(2).max(40).optional(),
  anonymousDonations: z.boolean().optional(),
});

export async function GET(request: Request) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json(
      { error: "unauthorized", message: "Authentication required." },
      { status: 401 }
    );
  }

  const db = getDb();
  const [user] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      anonymousDonations: users.anonymousDonations,
      locale: users.locale,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) {
    return NextResponse.json(
      { error: "not_found", message: "User not found." },
      { status: 404 }
    );
  }

  const addresses = await db
    .select()
    .from(userAddresses)
    .where(eq(userAddresses.userId, session.userId));

  const roleRows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, session.userId));

  return NextResponse.json({
    user: {
      ...user,
      roles: roleRows.map((r) => r.role),
      addresses,
    },
  });
}

export async function PATCH(request: Request) {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const parsed = UpdateUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_request", message: "Invalid payload: " + parsed.error.message },
      { status: 400 }
    );
  }

  const db = getDb();
  const updateData: Partial<typeof users.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (parsed.data.displayName !== undefined) {
    updateData.displayName = parsed.data.displayName;
  }
  if (parsed.data.anonymousDonations !== undefined) {
    updateData.anonymousDonations = parsed.data.anonymousDonations;
  }

  const [updated] = await db
    .update(users)
    .set(updateData)
    .where(eq(users.id, session.userId))
    .returning();

  if (!updated) {
    return NextResponse.json(
      { error: "not_found", message: "User not found." },
      { status: 404 }
    );
  }

  const ip = getClientIp(request);
  await db.insert(auditLog).values({
    actorUserId: session.userId,
    action: "user.updated",
    entityType: "user",
    entityId: session.userId,
    ip,
  });

  return NextResponse.json({
    user: {
      id: updated.id,
      displayName: updated.displayName,
      email: updated.email,
      anonymousDonations: updated.anonymousDonations,
      locale: updated.locale,
    },
  });
}
