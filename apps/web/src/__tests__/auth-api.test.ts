import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as handleSessionPost, DELETE as handleSessionDelete } from "@/app/api/auth/session/route";
import { POST as handleWalletSync } from "@/app/api/auth/wallets/sync/route";
import { PATCH as handleUserPatch } from "@/app/api/auth/user/route";
import { DELETE as handleAccountDelete } from "@/app/api/auth/account/route";
import { setPrivyClientForTesting } from "@/lib/auth/privy";
import { signSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { authRateLimiter } from "@/lib/security/rate-limit";
import type { PrivyClient } from "@privy-io/server-auth";

// In-memory mock DB data structures for pure integration tests
describe("Auth API Handlers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    authRateLimiter.reset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setPrivyClientForTesting(null);
  });

  describe("POST /api/auth/session", () => {
    it("returns 400 on empty or invalid JSON", async () => {
      const req = new Request("http://localhost:3000/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
        body: JSON.stringify({}),
      });

      const res = await handleSessionPost(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("bad_request");
    });

    it("returns 401 on invalid Privy token", async () => {
      const mockPrivy = {
        verifyAuthToken: vi.fn().mockRejectedValue(new Error("Invalid token")),
      } as unknown as PrivyClient;

      setPrivyClientForTesting(mockPrivy);

      const req = new Request("http://localhost:3000/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
        body: JSON.stringify({ accessToken: "bad_token" }),
      });

      const res = await handleSessionPost(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("unauthorized");
    });

    it("returns 403 on invalid origin in dev environment", async () => {
      process.env.APP_ENV = "dev";

      const req = new Request("https://dev.cherr.io/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.com" },
        body: JSON.stringify({ accessToken: "some_token" }),
      });

      const res = await handleSessionPost(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("forbidden");
    });

    it("returns 429 when rate limit is exceeded", async () => {
      const mockPrivy = {
        verifyAuthToken: vi.fn().mockRejectedValue(new Error("Invalid token")),
      } as unknown as PrivyClient;

      setPrivyClientForTesting(mockPrivy);

      // Exceed 20 requests
      for (let i = 0; i < 20; i++) {
        const req = new Request("http://localhost:3000/api/auth/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:3000",
            "X-Forwarded-For": "198.51.100.1",
          },
          body: JSON.stringify({ accessToken: "token" }),
        });
        await handleSessionPost(req);
      }

      // 21st request
      const reqBlocked = new Request("http://localhost:3000/api/auth/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          "X-Forwarded-For": "198.51.100.1",
        },
        body: JSON.stringify({ accessToken: "token" }),
      });
      const res = await handleSessionPost(reqBlocked);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeDefined();
    });
  });

  describe("DELETE /api/auth/session", () => {
    it("returns 403 on invalid origin in dev environment", async () => {
      process.env.APP_ENV = "dev";

      const req = new Request("https://dev.cherr.io/api/auth/session", {
        method: "DELETE",
        headers: { Origin: "https://evil.com" },
      });

      const res = await handleSessionDelete(req);
      expect(res.status).toBe(403);
    });

    it("returns 200 and clears the session cookie and the admin second-factor cookie", async () => {
      const req = new Request("http://localhost:3000/api/auth/session", {
        method: "DELETE",
        headers: { Origin: "http://localhost:3000" },
      });

      const res = await handleSessionDelete(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      const cleared = res.headers.getSetCookie().filter((c) => /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c));
      expect(cleared.map((c) => c.split("=")[0]).sort()).toEqual(["cherrio_admin_mfa", "cherrio_session"]);
    });
  });

  describe("PATCH /api/auth/user", () => {
    it("returns 401 when no session exists", async () => {
      const req = new Request("http://localhost:3000/api/auth/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
        body: JSON.stringify({ displayName: "New Name" }),
      });

      const res = await handleUserPatch(req);
      expect(res.status).toBe(401);
    });

    it("returns 400 when displayName is too short or too long", async () => {
      const token = await signSessionToken({ userId: "mock-user-id", roles: [] });
      const req = new Request("http://localhost:3000/api/auth/user", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
        body: JSON.stringify({ displayName: "A" }), // too short (< 2)
      });

      const res = await handleUserPatch(req);
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/auth/wallets/sync", () => {
    it("returns 401 when no session exists", async () => {
      const req = new Request("http://localhost:3000/api/auth/wallets/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      });

      const res = await handleWalletSync(req);
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /api/auth/account", () => {
    it("returns 401 when unauthenticated", async () => {
      const req = new Request("http://localhost:3000/api/auth/account", {
        method: "DELETE",
        headers: { Origin: "http://localhost:3000" },
      });

      const res = await handleAccountDelete(req);
      expect(res.status).toBe(401);
    });
  });
});
