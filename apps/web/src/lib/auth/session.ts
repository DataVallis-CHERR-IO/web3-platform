import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { eq, and } from "drizzle-orm";
import { parseAppEnv } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { users, userRoles } from "@cherrio/db";

export const SESSION_COOKIE_NAME = "cherrio_session";
export const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface SessionPayload {
  userId: string;
  roles: string[];
}

/** The raw SESSION_SECRET bytes (also the HKDF input of the admin MFA keys, ADR-056). */
export function getSecretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    const appEnv = process.env.APP_ENV ?? "local";
    if (appEnv !== "local") {
      throw new Error(`[Auth] Missing SESSION_SECRET in ${appEnv} environment`);
    }
    // Fallback for local tests/CI when not configured
    return new TextEncoder().encode("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Signs a session JWT token with HS256.
 */
export async function signSessionToken(payload: SessionPayload): Promise<string> {
  const secret = getSecretKey();
  return new SignJWT({
    sub: payload.userId,
    roles: payload.roles,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(secret);
}

/**
 * Verifies and decodes a session JWT token.
 */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const secret = getSecretKey();
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });

    if (!payload.sub) return null;

    return {
      userId: payload.sub,
      roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
    };
  } catch {
    return null;
  }
}

/**
 * Reads and verifies the current session cookie from request headers or Next.js cookie store.
 */
export async function getSession(
  reqOrCookie?: Request | string
): Promise<SessionPayload | null> {
  let token: string | undefined;

  if (typeof reqOrCookie === "string") {
    const match = reqOrCookie.match(
      new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`)
    );
    token = match?.[1];
  } else if (reqOrCookie instanceof Request) {
    const cookieHeader = reqOrCookie.headers.get("cookie") ?? "";
    const match = cookieHeader.match(
      new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`)
    );
    token = match?.[1];
  } else {
    try {
      const cookieStore = await cookies();
      token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    } catch {
      return null;
    }
  }

  if (!token) return null;
  const decoded = await verifySessionToken(token);
  if (!decoded) return null;

  // Confirm in DB that the user exists and is not erased (privy_did IS NOT NULL).
  try {
    const db = getDb();
    const [user] = await db
      .select({ id: users.id, privyDid: users.privyDid })
      .from(users)
      .where(eq(users.id, decoded.userId))
      .limit(1);

    if (!user || !user.privyDid) {
      return null;
    }
  } catch {
    // If DB is offline/unreachable in local test mode, fall through only if local mock
    if (process.env.APP_ENV !== "local") {
      return null;
    }
  }

  return decoded;
}

/**
 * Ensures a valid session exists. Throws Error if not authenticated.
 */
export async function requireUser(
  reqOrCookie?: Request | string
): Promise<SessionPayload> {
  const session = await getSession(reqOrCookie);
  if (!session) {
    throw new Error("UNAUTHORIZED");
  }
  return session;
}

/**
 * The PLATFORM_ADMIN role alone, RE-READ from the DB (never the cookie's role
 * claim). Only for the second-factor screens and routes (ADR-056); everything
 * else in the admin area uses requireRole.
 */
export async function requirePlatformAdminRole(reqOrCookie?: Request | string): Promise<SessionPayload> {
  const session = await requireUser(reqOrCookie);
  const db = getDb();

  const [dbRole] = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(and(eq(userRoles.userId, session.userId), eq(userRoles.role, "PLATFORM_ADMIN")))
    .limit(1);

  if (!dbRole) {
    throw new Error("FORBIDDEN");
  }

  return session;
}

/**
 * The gate of the whole admin area: the PLATFORM_ADMIN role RE-READ from the DB
 * (never the cookie's role claim) AND a valid second-factor cookie for the
 * user's current enrolment (ADR-056). Throws FORBIDDEN / MFA_REQUIRED; every
 * caller answers 404, so the admin area stays invisible.
 */
export async function requireRole(
  role: "PLATFORM_ADMIN",
  reqOrCookie?: Request | string
): Promise<SessionPayload> {
  void role;
  const session = await requirePlatformAdminRole(reqOrCookie);
  // Imported here: admin-mfa imports this module (cookie options, secret).
  const { hasValidMfa, readMfaCookie } = await import("./admin-mfa");
  if (!(await hasValidMfa(getDb(), session.userId, await readMfaCookie(reqOrCookie)))) {
    throw new Error("MFA_REQUIRED");
  }
  return session;
}

/**
 * Returns cookie options matching ADR-024 security requirements.
 */
export function getSessionCookieOptions() {
  const rawEnv = process.env.APP_ENV ?? "local";
  let appEnv = "local";
  try {
    appEnv = parseAppEnv(rawEnv);
  } catch {
    appEnv = "local";
  }

  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: appEnv !== "local",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  };
}
