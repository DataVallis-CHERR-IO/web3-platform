import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

// Pure building blocks of the admin second factor (ADR-056): RFC 6238 TOTP,
// base32, secret encryption, recovery codes. No database, no cookies.

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accepted clock drift in time steps on either side (±30 s). */
export const TOTP_DRIFT_STEPS = 1;
export const RECOVERY_CODE_COUNT = 10;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit TOTP secret (the RFC 4226 recommended length). */
export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP (RFC 4226) for one counter value; TOTP = HOTP(secret, time step). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * The time step a 6-digit code belongs to (now ±1 step), or null. A step at or
 * below `lastUsedStep` is refused, so each code works once.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = timeStep(nowMs);
  for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift++) {
    const step = current + drift;
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/** otpauth:// URI that authenticator apps read from the QR code. */
export function otpauthUri(secret: Buffer, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── keys derived from SESSION_SECRET (ADR-056 §3) ───────────────────────────────

export type MfaKeyPurpose = "secret-encryption" | "cookie";

export function deriveMfaKey(sessionSecret: Uint8Array, purpose: MfaKeyPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret, "cherrio-admin-mfa", `cherrio/admin-mfa/${purpose}/v1`, 32));
}

/**
 * AES-256-GCM; stored as `v1.<iv>.<tag>.<ciphertext>` (base64url). The owner's
 * user id is authenticated data: a ciphertext copied into another admin's row
 * does not decrypt.
 */
export function encryptSecret(secret: Buffer, key: Buffer, userId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(userId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** Throws if the value was tampered with, encrypted with another key, or belongs to another user. */
export function decryptSecret(stored: string, key: Buffer, userId: string): Buffer {
  const [version, iv, tag, ciphertext] = stored.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("unknown secret format");
  const authTag = Buffer.from(tag, "base64url");
  if (authTag.length !== 16) throw new Error("unknown secret format"); // no truncated tags
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
}

// ── recovery codes ────────────────────────────────────────────────────────────

/** `XXXX-XXXX-XXXX` from the base32 alphabet (60 random bits each). */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const chars = base32Encode(randomBytes(8)).slice(0, 12);
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

/** Case, spaces and dashes do not matter when a code is typed back. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

export function looksLikeRecoveryCode(code: string): boolean {
  return /^[A-Z2-7]{12}$/.test(normalizeRecoveryCode(code));
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}
