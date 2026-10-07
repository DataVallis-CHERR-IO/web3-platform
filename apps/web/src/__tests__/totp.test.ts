import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  deriveMfaKey,
  encryptSecret,
  hashRecoveryCode,
  hotp,
  looksLikeRecoveryCode,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  timeStep,
} from "@/lib/auth/totp";

// ADR-056 building blocks, no database.

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("TOTP (RFC 6238, SHA-1)", () => {
  // RFC 6238 Appendix B, SHA-1 column (8 digits).
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("time %i → %s", (seconds, expected) => {
    expect(hotp(RFC_SECRET, timeStep(seconds * 1000), 8)).toBe(expected);
  });

  it("6-digit codes are the last six digits of the RFC vector", () => {
    expect(hotp(RFC_SECRET, timeStep(59_000))).toBe("287082");
  });

  const now = 1_759_800_000_000;
  const step = timeStep(now);

  it("accepts the current step and ±1 step of drift, refuses ±2", () => {
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step), now, null)).toBe(step);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now, null)).toBeNull();
  });

  it("refuses a step at or before the last used one (each code works once)", () => {
    const code = hotp(RFC_SECRET, step);
    expect(matchTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(matchTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
  });

  it("refuses codes that are not six digits", () => {
    expect(matchTotp(RFC_SECRET, "", now, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, "12345", now, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, "abcdef", now, null)).toBeNull();
  });
});

describe("base32 and the otpauth URI", () => {
  it("round-trips and matches the RFC 4648 vector", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    const secret = newTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(() => base32Decode("1!")).toThrow();
  });

  it("names the issuer and carries the algorithm parameters", () => {
    const uri = otpauthUri(RFC_SECRET, "CHERR.IO dev", "David");
    expect(uri).toBe(
      "otpauth://totp/CHERR.IO%20dev%3ADavid?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=CHERR.IO+dev&algorithm=SHA1&digits=6&period=30"
    );
  });
});

describe("secret encryption", () => {
  const sessionSecret = new TextEncoder().encode("a".repeat(64));
  const key = deriveMfaKey(sessionSecret, "secret-encryption");

  it("round-trips, and each encryption is different", () => {
    const a = encryptSecret(RFC_SECRET, key);
    const b = encryptSecret(RFC_SECRET, key);
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(decryptSecret(a, key).equals(RFC_SECRET)).toBe(true);
  });

  it("fails for a tampered value or another key", () => {
    const stored = encryptSecret(RFC_SECRET, key);
    const [v, iv, tag, ct] = stored.split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64url")].join("."), key)).toThrow();
    expect(() => decryptSecret(stored, deriveMfaKey(new TextEncoder().encode("b".repeat(64)), "secret-encryption"))).toThrow();
    expect(() => decryptSecret(stored, deriveMfaKey(sessionSecret, "cookie"))).toThrow();
  });
});

describe("recovery codes", () => {
  it("ten distinct XXXX-XXXX-XXXX codes; hashes ignore case, spaces and dashes", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
      expect(looksLikeRecoveryCode(code)).toBe(true);
    }
    const code = codes[0]!;
    expect(hashRecoveryCode(code.toLowerCase().replace(/-/g, " "))).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(code)).not.toBe(hashRecoveryCode(codes[1]!));
    expect(looksLikeRecoveryCode("123456")).toBe(false);
  });
});
