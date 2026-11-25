import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { base32Decode, hotp, msUntilNextStep, saveEnrolment, timeStep, totp } from "../src/staff.js";

// RFC 6238 appendix B, SHA-1 key "12345678901234567890". The RFC lists 8 digits;
// the admin gate uses 6, which are the last 6 of the same number.
const RFC_KEY = Buffer.from("12345678901234567890");
const RFC_VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("staff agent TOTP (same parameters as the admin gate)", () => {
  it("matches the RFC 6238 test vectors", () => {
    for (const [seconds, code] of RFC_VECTORS) {
      expect(hotp(RFC_KEY, timeStep(seconds * 1000), 8), `T=${seconds}`).toBe(code);
      expect(totp(RFC_KEY, seconds * 1000).code, `T=${seconds}`).toBe(code.slice(2));
    }
  });

  it("reads the key as the enrolment page shows it (groups of four, any case)", () => {
    // base32 of "12345678901234567890"
    const shown = "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ";
    expect(base32Decode(shown).equals(RFC_KEY)).toBe(true);
    expect(base32Decode(shown.toLowerCase().replace(/ /g, "")).equals(RFC_KEY)).toBe(true);
    expect(() => base32Decode("NOT-BASE32-1!")).toThrow("not base32");
    expect(() => base32Decode("   ")).toThrow("empty");
  });

  it("waits for a later step before reusing the gate after an enrolment code", () => {
    const now = 1_000_000_000_000; // exactly on a step boundary
    const step = timeStep(now);
    expect(timeStep(now + msUntilNextStep(now, step))).toBe(step + 1);
    const late = now + 29_500; // half a second before the next step
    expect(timeStep(late + msUntilNextStep(late, step))).toBe(step + 1);
    expect(msUntilNextStep(now + 60_000, step)).toBe(1_000); // already later: only the margin
  });
});

describe("saveEnrolment", () => {
  it("writes the key without a newline and the codes, readable only by the owner", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "staff-")), "nested");
    const paths = { secret: join(dir, "secret.txt"), recovery: join(dir, "codes.txt") };
    const codes = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCC${"234567ABCD"[i]}`);
    saveEnrolment({ secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", recoveryCodes: codes }, paths);
    expect(readFileSync(paths.secret, "utf8")).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"); // `gh secret set … < file` stores it as is
    expect(readFileSync(paths.recovery, "utf8").trim().split("\n")).toEqual(codes);
    for (const p of [paths.secret, paths.recovery]) expect(statSync(p).mode & 0o777, p).toBe(0o600);
  });

  it("tightens the mode of a file and a folder that already exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "staff-"));
    chmodSync(dir, 0o755);
    const paths = { secret: join(dir, "secret.txt"), recovery: join(dir, "codes.txt") };
    writeFileSync(paths.secret, "old", { mode: 0o644 });
    saveEnrolment({ secret: "GEZDGNBV", recoveryCodes: ["AAAA-BBBB-CCCC"] }, paths);
    expect(statSync(paths.secret).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
