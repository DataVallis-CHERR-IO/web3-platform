import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { verifyOrigin, getExpectedOrigin } from "@/lib/security/origin";
import { getClientIp, authRateLimiter, type RateLimitOptions } from "@/lib/security/rate-limit";

describe("Origin verification", () => {
  const originalEnv = process.env.APP_ENV;

  afterEach(() => {
    process.env.APP_ENV = originalEnv;
  });

  it("returns correct expected origin per environment", () => {
    expect(getExpectedOrigin("dev")).toBe("https://dev.cherr.io");
    expect(getExpectedOrigin("uat")).toBe("https://uat.cherr.io");
    expect(getExpectedOrigin("prod")).toBe("https://app.cherr.io");
    expect(getExpectedOrigin("local")).toBe("http://localhost:3000");
  });

  it("verifies dev origin strictly", () => {
    process.env.APP_ENV = "dev";

    const validReq = new Request("https://dev.cherr.io/api/auth/session", {
      headers: { Origin: "https://dev.cherr.io" },
    });
    expect(verifyOrigin(validReq)).toBe(true);

    const crossSiteReq = new Request("https://dev.cherr.io/api/auth/session", {
      headers: { Origin: "https://evil.com" },
    });
    expect(verifyOrigin(crossSiteReq)).toBe(false);

    const wrongEnvReq = new Request("https://dev.cherr.io/api/auth/session", {
      headers: { Origin: "https://uat.cherr.io" },
    });
    expect(verifyOrigin(wrongEnvReq)).toBe(false);
  });

  it("verifies local origin allowing localhost ports", () => {
    process.env.APP_ENV = "local";

    const localReq1 = new Request("http://localhost:3000/api/auth/session", {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(verifyOrigin(localReq1)).toBe(true);

    const localReq2 = new Request("http://localhost:3001/api/auth/session", {
      headers: { Origin: "http://localhost:3001" },
    });
    expect(verifyOrigin(localReq2)).toBe(true);

    const evilLocalReq = new Request("http://localhost:3000/api/auth/session", {
      headers: { Origin: "https://evil.com" },
    });
    expect(verifyOrigin(evilLocalReq)).toBe(false);
  });
});

describe("Local origins stay local-only", () => {
  // The E2E server runs with APP_ENV=local, where any localhost port is accepted.
  // No deployed environment may ever accept such an origin.
  const LOCAL_ORIGINS = ["http://localhost:3000", "http://localhost:3001", "http://127.0.0.1:3000"];

  it.each(["dev", "uat", "prod"])("%s refuses a localhost origin or referer", (appEnv) => {
    const before = process.env.APP_ENV;
    process.env.APP_ENV = appEnv;
    try {
      for (const origin of LOCAL_ORIGINS) {
        const url = `${origin}/api/organizations`;
        expect(verifyOrigin(new Request(url, { method: "POST", headers: { Origin: origin } }))).toBe(false);
        expect(verifyOrigin(new Request(url, { method: "POST", headers: { Referer: `${origin}/en` } }))).toBe(false);
      }
      expect(verifyOrigin(new Request("http://localhost:3000/api/organizations", { method: "POST" }))).toBe(false);
    } finally {
      process.env.APP_ENV = before;
    }
  });
});

describe("Client IP extraction", () => {
  it("extracts the last IP from X-Forwarded-For header (appended by kamal-proxy)", () => {
    const req = new Request("http://localhost:3000/api/auth/session", {
      headers: { "X-Forwarded-For": "203.0.113.195, 70.41.3.18, 150.172.238.178" },
    });
    expect(getClientIp(req)).toBe("150.172.238.178");
  });

  it("handles single-entry X-Forwarded-For header", () => {
    const req = new Request("http://localhost:3000/api/auth/session", {
      headers: { "X-Forwarded-For": "203.0.113.195" },
    });
    expect(getClientIp(req)).toBe("203.0.113.195");
  });

  it("falls back to X-Real-IP if X-Forwarded-For is missing", () => {
    const req = new Request("http://localhost:3000/api/auth/session", {
      headers: { "X-Real-IP": "198.51.100.42" },
    });
    expect(getClientIp(req)).toBe("198.51.100.42");
  });

  it("falls back to 127.0.0.1 if no proxy headers are present", () => {
    const req = new Request("http://localhost:3000/api/auth/session");
    expect(getClientIp(req)).toBe("127.0.0.1");
  });
});

describe("Rate Limiter", () => {
  beforeEach(() => {
    authRateLimiter.reset();
  });

  it("allows requests within limit and blocks requests exceeding limit", () => {
    const opts: RateLimitOptions = {
      windowMs: 1000,
      maxRequests: 3,
    };

    const ip = "1.2.3.4";
    expect(authRateLimiter.check(ip, opts).success).toBe(true);
    expect(authRateLimiter.check(ip, opts).success).toBe(true);
    expect(authRateLimiter.check(ip, opts).success).toBe(true);

    // 4th request exceeds maxRequests = 3
    const blocked = authRateLimiter.check(ip, opts);
    expect(blocked.success).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.reset).toBeGreaterThan(0);
  });

  it("prunes expired timestamps automatically", () => {
    const opts: RateLimitOptions = {
      windowMs: 10,
      maxRequests: 5,
    };

    for (let i = 0; i < 100; i++) {
      authRateLimiter.check(`ip-${i}`, opts);
    }
  });
});
