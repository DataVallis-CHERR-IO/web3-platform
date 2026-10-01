import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  signSessionToken,
  verifySessionToken,
} from "@/lib/auth/session";
import { generateDefaultDisplayName } from "@/lib/auth/user-helpers";

describe("session token handling", () => {
  const originalEnv = process.env.SESSION_SECRET;

  beforeEach(() => {
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  afterEach(() => {
    process.env.SESSION_SECRET = originalEnv;
  });

  it("signs and verifies a valid session token", async () => {
    const payload = {
      userId: "018f6732-5a9e-7821-9921-123456789abc",
      roles: ["PLATFORM_ADMIN"],
    };

    const token = await signSessionToken(payload);
    expect(typeof token).toBe("string");

    const decoded = await verifySessionToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.userId).toBe(payload.userId);
    expect(decoded?.roles).toEqual(payload.roles);
  });

  it("rejects an invalid or forged token", async () => {
    const forgedToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M";
    const decoded = await verifySessionToken(forgedToken);
    expect(decoded).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const payload = { userId: "user-123", roles: [] };
    const token = await signSessionToken(payload);

    // Change secret
    process.env.SESSION_SECRET = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const decoded = await verifySessionToken(token);
    expect(decoded).toBeNull();
  });
});

describe("user helpers", () => {
  it("generates default display name with 'Supporter' prefix and 4 random characters", () => {
    const name = generateDefaultDisplayName();
    expect(name).toMatch(/^Supporter [0-9A-Z]{4}$/);
  });

  it("generates distinct names across multiple calls", () => {
    const set = new Set<string>();
    for (let i = 0; i < 50; i++) {
      set.add(generateDefaultDisplayName());
    }
    expect(set.size).toBeGreaterThan(45);
  });
});
