import { SignJWT, jwtVerify } from "jose";
import { and, eq, isNotNull, isNull, or, lt, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { adminMfa, auditLog, users, type Database } from "@cherrio/db";
import { getSecretKey, getSessionCookieOptions } from "./session";
import {
  decryptSecret,
  deriveMfaKey,
  encryptSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  base32Encode,
} from "./totp";

// The admin second factor (ADR-056, TASK-049): enrolment, verification and the
// short-lived `cherrio_admin_mfa` cookie that proves it.

export const MFA_COOKIE_NAME = "cherrio_admin_mfa";
export const MFA_COOKIE_SECONDS = 12 * 60 * 60;

export type MfaErrorCode = "already_enrolled" | "not_enrolled" | "no_pending_enrolment" | "invalid_code";

export class MfaError extends Error {
  constructor(readonly code: MfaErrorCode) {
    super(code);
  }
}

export type MfaStatus = "none" | "pending" | "confirmed";

export async function getMfaStatus(db: Database, userId: string): Promise<{ status: MfaStatus; id: string | null }> {
  const [row] = await db
    .select({ id: adminMfa.id, confirmedAt: adminMfa.confirmedAt })
    .from(adminMfa)
    .where(eq(adminMfa.userId, userId))
    .limit(1);
  if (!row) return { status: "none", id: null };
  return { status: row.confirmedAt ? "confirmed" : "pending", id: row.id };
}

function issuer(appEnv = process.env.APP_ENV ?? "local"): string {
  return appEnv === "prod" ? "CHERR.IO" : `CHERR.IO ${appEnv}`;
}

export interface Enrolment {
  /** Key in text for apps that cannot scan (base32, groups of four). */
  secret: string;
  otpauthUri: string;
  /** `data:image/svg+xml` URL of the QR code. */
  qrDataUrl: string;
}

/**
 * Starts (or restarts) an enrolment with a new secret. Refused while a
 * confirmed factor exists — a stolen session must not be able to replace it.
 */
export async function startEnrolment(db: Database, userId: string): Promise<Enrolment> {
  const [user] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
  const secret = newTotpSecret();
  const secretEnc = encryptSecret(secret, deriveMfaKey(getSecretKey(), "secret-encryption"));
  const [row] = await db
    .insert(adminMfa)
    .values({ userId, secretEnc })
    .onConflictDoUpdate({
      target: adminMfa.userId,
      set: { id: sql`excluded.id`, secretEnc, lastUsedStep: null, recoveryCodeHashes: [] },
      setWhere: isNull(adminMfa.confirmedAt),
    })
    .returning({ id: adminMfa.id });
  if (!row) throw new MfaError("already_enrolled");

  const uri = otpauthUri(secret, issuer(), user?.displayName ?? "admin");
  const svg = await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  return {
    secret: base32Encode(secret).replace(/(.{4})/g, "$1 ").trim(),
    otpauthUri: uri,
    qrDataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
  };
}

/** Marks the step used only if no later or equal step was used meanwhile (two requests with one code). */
async function claimStep(db: Database, id: string, step: number, confirm: boolean, recoveryCodeHashes?: string[]) {
  const [row] = await db
    .update(adminMfa)
    .set({
      lastUsedStep: step,
      ...(confirm ? { confirmedAt: new Date() } : {}),
      ...(recoveryCodeHashes ? { recoveryCodeHashes } : {}),
    })
    .where(
      and(
        eq(adminMfa.id, id),
        confirm ? isNull(adminMfa.confirmedAt) : isNotNull(adminMfa.confirmedAt),
        or(isNull(adminMfa.lastUsedStep), lt(adminMfa.lastUsedStep, step))
      )
    )
    .returning({ id: adminMfa.id });
  return row ?? null;
}

async function loadRow(db: Database, userId: string) {
  const [row] = await db.select().from(adminMfa).where(eq(adminMfa.userId, userId)).limit(1);
  return row ?? null;
}

/** First code from the app: confirms the enrolment and returns the recovery codes (shown once). */
export async function confirmEnrolment(
  db: Database,
  userId: string,
  code: string,
  options: { now?: number; ip?: string } = {}
): Promise<{ id: string; recoveryCodes: string[] }> {
  const row = await loadRow(db, userId);
  if (!row) throw new MfaError("no_pending_enrolment");
  if (row.confirmedAt) throw new MfaError("already_enrolled");
  const secret = decryptSecret(row.secretEnc, deriveMfaKey(getSecretKey(), "secret-encryption"));
  const step = matchTotp(secret, code.trim(), options.now ?? Date.now(), row.lastUsedStep);
  if (step === null) throw new MfaError("invalid_code");

  const recoveryCodes = newRecoveryCodes();
  const claimed = await claimStep(db, row.id, step, true, recoveryCodes.map(hashRecoveryCode));
  if (!claimed) throw new MfaError("invalid_code");
  await db.insert(auditLog).values({
    actorUserId: userId, action: "admin.mfa_enrolled", entityType: "user", entityId: userId, ip: options.ip,
  });
  return { id: row.id, recoveryCodes };
}

/** A code from the app or a recovery code; returns the enrolment id the cookie is bound to. */
export async function verifyFactor(
  db: Database,
  userId: string,
  input: string,
  options: { now?: number; ip?: string } = {}
): Promise<{ id: string; method: "totp" | "recovery"; recoveryCodesLeft: number }> {
  const row = await loadRow(db, userId);
  if (!row || !row.confirmedAt) throw new MfaError("not_enrolled");
  const code = input.trim();

  if (/^\d{6}$/.test(code)) {
    const secret = decryptSecret(row.secretEnc, deriveMfaKey(getSecretKey(), "secret-encryption"));
    const step = matchTotp(secret, code, options.now ?? Date.now(), row.lastUsedStep);
    if (step === null || !(await claimStep(db, row.id, step, false))) throw new MfaError("invalid_code");
    await audit(db, userId, "totp", row.recoveryCodeHashes.length, options.ip);
    return { id: row.id, method: "totp", recoveryCodesLeft: row.recoveryCodeHashes.length };
  }

  if (looksLikeRecoveryCode(code)) {
    const hash = hashRecoveryCode(code);
    // Removes the code only if it is still there: a code works once, also under concurrent requests.
    const [used] = await db
      .update(adminMfa)
      .set({ recoveryCodeHashes: sql`array_remove(${adminMfa.recoveryCodeHashes}, ${hash})` })
      .where(and(eq(adminMfa.id, row.id), isNotNull(adminMfa.confirmedAt), sql`${hash} = any(${adminMfa.recoveryCodeHashes})`))
      .returning({ left: adminMfa.recoveryCodeHashes });
    if (!used) throw new MfaError("invalid_code");
    await audit(db, userId, "recovery", used.left.length, options.ip);
    return { id: row.id, method: "recovery", recoveryCodesLeft: used.left.length };
  }

  throw new MfaError("invalid_code");
}

async function audit(db: Database, userId: string, method: "totp" | "recovery", left: number, ip?: string) {
  await db.insert(auditLog).values({
    actorUserId: userId, action: "admin.mfa_verified", entityType: "user", entityId: userId,
    data: { method, recoveryCodesLeft: left }, ip,
  });
}

// ── the cookie ────────────────────────────────────────────────────────────────

function cookieKey(): Uint8Array {
  return deriveMfaKey(getSecretKey(), "cookie");
}

export async function signMfaCookie(userId: string, enrolmentId: string): Promise<string> {
  return new SignJWT({ sub: userId, mfa: enrolmentId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MFA_COOKIE_SECONDS}s`)
    .sign(cookieKey());
}

export function mfaCookieOptions() {
  return { ...getSessionCookieOptions(), name: MFA_COOKIE_NAME, maxAge: MFA_COOKIE_SECONDS };
}

/** Reads the MFA cookie from a request, a raw cookie header, or (no argument) the Next.js cookie store. */
export async function readMfaCookie(reqOrCookie?: Request | string): Promise<string | undefined> {
  if (reqOrCookie === undefined) {
    try {
      const { cookies } = await import("next/headers");
      return (await cookies()).get(MFA_COOKIE_NAME)?.value;
    } catch {
      return undefined;
    }
  }
  const header = typeof reqOrCookie === "string" ? reqOrCookie : (reqOrCookie.headers.get("cookie") ?? "");
  return header.match(new RegExp(`(?:^|;\\s*)${MFA_COOKIE_NAME}=([^;]+)`))?.[1];
}

/**
 * True only if the cookie is valid, belongs to this user and to the user's
 * current confirmed enrolment (a reset or re-enrolment invalidates old cookies).
 */
export async function hasValidMfa(db: Database, userId: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  let claims: { sub?: string; mfa?: unknown };
  try {
    ({ payload: claims } = await jwtVerify(token, cookieKey(), { algorithms: ["HS256"] }));
  } catch {
    return false;
  }
  if (claims.sub !== userId || typeof claims.mfa !== "string") return false;
  const { status, id } = await getMfaStatus(db, userId);
  return status === "confirmed" && id === claims.mfa;
}
