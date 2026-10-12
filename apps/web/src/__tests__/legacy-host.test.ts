import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import middleware from "@/middleware";

// dev.cherr.io is the older name of the testnet beta: pages move to
// testnet.cherr.io, API routes keep answering (open tabs, older emails).
const call = (url: string, headers: Record<string, string>, method = "GET") =>
  middleware(new NextRequest(new URL(url, "http://0.0.0.0:3000"), { method, headers }));

describe("older dev host", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("redirects pages on dev.cherr.io to testnet.cherr.io, keeping path and query", () => {
    vi.stubEnv("APP_ENV", "dev");
    const res = call("/en/campaigns/roof?ref=abcdefgh", { host: "dev.cherr.io" });
    expect([res.status, res.headers.get("location")]).toEqual([
      308,
      "https://testnet.cherr.io/en/campaigns/roof?ref=abcdefgh",
    ]);
    const viaProxy = call("/", { host: "0.0.0.0:3000", "x-forwarded-host": "dev.cherr.io" });
    expect([viaProxy.status, viaProxy.headers.get("location")]).toEqual([308, "https://testnet.cherr.io/"]);
  });

  it("leaves API routes, the public name and other environments alone", () => {
    vi.stubEnv("APP_ENV", "dev");
    expect(call("/api/health", { host: "dev.cherr.io" }).headers.get("location")).toBeNull();
    expect(call("/en", { host: "dev.cherr.io" }, "POST").status).not.toBe(308);
    expect(call("/en", { host: "testnet.cherr.io" }).status).not.toBe(308);
    vi.stubEnv("APP_ENV", "prod");
    expect(call("/en", { host: "dev.cherr.io" }).status).not.toBe(308);
  });
});
