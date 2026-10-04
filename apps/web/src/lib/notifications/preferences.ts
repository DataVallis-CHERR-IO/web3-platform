import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { auditLog, notificationPreferences, notifications, pointsLedger, users, type Database } from "@cherrio/db";

// Email notification preferences (TASK-033e part 3, ADR-048). The worker sends;
// the web app only stores the user's choice, the double opt-in of a contact
// address for wallet-only users, and the one-click unsubscribe. Tokens are
// random and stored as SHA-256; the raw confirmation token travels only in the
// queued EMAIL_CONFIRM row (removed once sent) and in the email itself.

export const CONFIRM_TTL_MS = 24 * 3_600_000;
export const CONFIRM_REQUESTS_PER_HOUR = 3;

export class NotificationPreferenceError extends Error {
  constructor(public readonly code: "email_invalid" | "too_many_requests" | "same_as_login") {
    super(code);
    this.name = "NotificationPreferenceError";
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randomToken = () => randomBytes(24).toString("base64url");

/** A pragmatic address check: one @, a dot in the domain, no spaces, ≤ 254 chars. */
export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export interface NotificationSettings {
  emailEnabled: boolean;
  /** From login (Privy, already verified). */
  loginEmail: string | null;
  /** Confirmed address of a wallet-only user; wins over the login email. */
  contactEmail: string | null;
  /** Waiting for confirmation (link valid until `pendingUntil`). */
  pendingEmail: string | null;
  pendingUntil: string | null;
  /** Where emails go now (null = nowhere). */
  sendsTo: string | null;
}

async function ensureRow(db: Database, userId: string) {
  await db.insert(notificationPreferences).values({ userId, unsubscribeToken: randomToken() }).onConflictDoNothing();
}

export async function getNotificationSettings(db: Database, userId: string, now = new Date()): Promise<NotificationSettings> {
  const [row] = await db
    .select({ loginEmail: users.email, p: notificationPreferences })
    .from(users)
    .leftJoin(notificationPreferences, eq(notificationPreferences.userId, users.id))
    .where(eq(users.id, userId));
  const p = row?.p ?? null;
  const pendingValid = !!(p?.pendingEmail && p.confirmExpiresAt && p.confirmExpiresAt > now);
  const emailEnabled = p?.emailEnabled ?? true;
  const address = p?.contactEmail ?? row?.loginEmail ?? null;
  return {
    emailEnabled,
    loginEmail: row?.loginEmail ?? null,
    contactEmail: p?.contactEmail ?? null,
    pendingEmail: pendingValid ? p!.pendingEmail : null,
    pendingUntil: pendingValid ? p!.confirmExpiresAt!.toISOString() : null,
    sendsTo: emailEnabled ? address : null,
  };
}

export async function setEmailEnabled(db: Database, userId: string, enabled: boolean, ip?: string) {
  await ensureRow(db, userId);
  await db.update(notificationPreferences).set({ emailEnabled: enabled }).where(eq(notificationPreferences.userId, userId));
  await db.insert(auditLog).values({
    actorUserId: userId, action: "notifications.email_enabled", entityType: "user", entityId: userId, data: { enabled }, ip,
  });
}

/**
 * Starts the double opt-in for a contact address: stores the token's hash and
 * queues a confirmation email (sent by the worker). At most 3 per hour.
 */
export async function requestContactEmail(db: Database, userId: string, input: string, now = new Date(), ip?: string) {
  const email = normalizeEmail(input);
  if (!email) throw new NotificationPreferenceError("email_invalid");
  const [login] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (login?.email && login.email.toLowerCase() === email) throw new NotificationPreferenceError("same_as_login");
  const [recent] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.kind, "EMAIL_CONFIRM"), gt(notifications.createdAt, new Date(now.getTime() - 3_600_000))));
  if ((recent?.n ?? 0) >= CONFIRM_REQUESTS_PER_HOUR) throw new NotificationPreferenceError("too_many_requests");

  const token = randomToken();
  const hash = sha256(token);
  await ensureRow(db, userId);
  await db.transaction(async (tx) => {
    await tx
      .update(notificationPreferences)
      .set({ pendingEmail: email, confirmTokenHash: hash, confirmExpiresAt: new Date(now.getTime() + CONFIRM_TTL_MS) })
      .where(eq(notificationPreferences.userId, userId));
    await tx.insert(notifications).values({
      userId, kind: "EMAIL_CONFIRM", dedupeKey: `confirm:${hash.slice(0, 16)}`, data: { email, token }, createdAt: now, sendAfter: now,
    });
    await tx.insert(auditLog).values({
      actorUserId: userId, action: "notifications.contact_email_requested", entityType: "user", entityId: userId, data: {}, ip,
    });
  });
  return { pendingEmail: email };
}

/** The link in the confirmation email. true = confirmed now (or the same token again). */
export async function confirmContactEmail(db: Database, token: string, now = new Date()): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const hash = sha256(token);
  const [row] = await db
    .update(notificationPreferences)
    .set({
      contactEmail: sql`${notificationPreferences.pendingEmail}`,
      confirmedAt: now,
      pendingEmail: null,
      confirmExpiresAt: null,
      emailEnabled: true,
    })
    .where(
      and(
        eq(notificationPreferences.confirmTokenHash, hash),
        sql`${notificationPreferences.pendingEmail} is not null`,
        gt(notificationPreferences.confirmExpiresAt, now)
      )
    )
    .returning({ userId: notificationPreferences.userId });
  if (row) {
    // The hash stays until the next request, so a second click on the same link still says "confirmed".
    await db.insert(auditLog).values({ actorUserId: row.userId, action: "notifications.contact_email_confirmed", entityType: "user", entityId: row.userId, data: {} });
    return true;
  }
  const [already] = await db
    .select({ userId: notificationPreferences.userId })
    .from(notificationPreferences)
    .where(and(eq(notificationPreferences.confirmTokenHash, hash), sql`${notificationPreferences.contactEmail} is not null`));
  return !!already;
}

export async function removeContactEmail(db: Database, userId: string, ip?: string) {
  await db
    .update(notificationPreferences)
    .set({ contactEmail: null, pendingEmail: null, confirmTokenHash: null, confirmExpiresAt: null, confirmedAt: null })
    .where(eq(notificationPreferences.userId, userId));
  await db.insert(auditLog).values({ actorUserId: userId, action: "notifications.contact_email_removed", entityType: "user", entityId: userId, data: {}, ip });
}

/** One-click unsubscribe (the token from the email). true when the token is known. */
export async function unsubscribeByToken(db: Database, token: string): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const [row] = await db
    .update(notificationPreferences)
    .set({ emailEnabled: false })
    .where(eq(notificationPreferences.unsubscribeToken, token))
    .returning({ userId: notificationPreferences.userId });
  if (!row) return false;
  await db.insert(auditLog).values({ actorUserId: row.userId, action: "notifications.unsubscribed", entityType: "user", entityId: row.userId, data: { via: "link" } });
  return true;
}

/** Proof of Charity balances (sum of the ledger, voided entries excluded). */
export async function pointBalances(db: Database, userId: string): Promise<{ status: bigint; reward: bigint; votes: number }> {
  const [row] = (await db.execute(sql`
    select coalesce(sum(delta) filter (where bucket = 'STATUS'), 0)::text as status,
           coalesce(sum(delta) filter (where bucket = 'REWARD'), 0)::text as reward,
           count(*) filter (where reason = 'VOTE' and bucket = 'STATUS')::int as votes
    from ${pointsLedger} where user_id = ${userId} and voided_at is null
  `)) as unknown as { status: string; reward: string; votes: number }[];
  return { status: BigInt(row?.status ?? "0"), reward: BigInt(row?.reward ?? "0"), votes: Number(row?.votes ?? 0) };
}
