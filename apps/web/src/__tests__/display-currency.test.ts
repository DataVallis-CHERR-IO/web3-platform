import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { fxRates, users } from "@cherrio/db";
import { RATE_SCALE, convertUsdc, roundScaled } from "@cherrio/shared";
import messages from "../../messages/en.json";
import { getDb } from "@/lib/db";
import { PUT as currencyRoute } from "@/app/api/preferences/currency/route";
import { preferencesRateLimiter } from "@/lib/security/rate-limit";
import { FxSourceError, parseCoinGecko, parseEcbAll, type SourceRate } from "@/lib/fx/sources";
import { FX_POLICY, getDisplayRates, resetFxMemory, type FxDeps } from "@/lib/fx/rates";
import { eurCentsAsUsdc, formatCurrencyAmount, usdcIn } from "@/lib/fx/display";
import { cleanUp, createUser, ORIGIN } from "./helpers/organizations";

// Display currency (ADR-040): parsers, the lazy refresh with its staleness
// rules against Postgres, formatting, and the preferences route.

const ECB = readFileSync(new URL("./fixtures/ecb-eurofxref-daily.xml", import.meta.url), "utf8");
const GECKO = JSON.stringify({
  bitcoin: { usd: 65000, last_updated_at: 1759400000 },
  ethereum: { usd: 2500.5, last_updated_at: 1759400000 },
  "polygon-ecosystem-token": { usd: 0.2345, last_updated_at: 1759400000 },
});
const usd = (text: string) => BigInt(Math.round(Number(text) * 1e6)) * 10n ** 12n; // test helper for round inputs only

describe("rate sources", () => {
  it("ECB: every currency as USD per unit, EUR itself, USD = 1", () => {
    const rates = new Map(parseEcbAll(ECB).map((r) => [r.currency, r]));
    expect(rates.get("EUR")!.usdPerUnit18).toBe(1_173_400_000_000_000_000n); // 1 EUR = 1.1734 USD
    expect(rates.get("USD")!.usdPerUnit18).toBe(RATE_SCALE);
    // 1 CHF = 1.1734 / 0.9352 USD
    expect(rates.get("CHF")!.usdPerUnit18).toBe((1_173_400_000_000_000_000n * RATE_SCALE) / 935_200_000_000_000_000n);
    expect(rates.get("EUR")!.rateAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(() => parseEcbAll("<Cube time='2026-10-01'><Cube currency='JPY' rate='172.41'/></Cube>")).toThrow(FxSourceError);
    expect(() => parseEcbAll("<html>maintenance</html>")).toThrow(FxSourceError);
  });

  it("CoinGecko: prices as written, sanity bands, broken answers refused", () => {
    const now = new Date("2026-10-03T10:00:00Z");
    const rates = new Map(parseCoinGecko(GECKO, now).map((r) => [r.currency, r]));
    expect(rates.get("BTC")!.usdPerUnit18).toBe(65_000n * RATE_SCALE);
    expect(rates.get("ETH")!.usdPerUnit18).toBe(2_500_500_000_000_000_000_000n);
    expect(rates.get("POL")!.usdPerUnit18).toBe(234_500_000_000_000_000n);
    expect(rates.get("BTC")!.rateAt.toISOString()).toBe("2025-10-02T10:13:20.000Z");
    // A BTC price of 1 USD is a broken answer, not a market move: skipped.
    expect(parseCoinGecko(JSON.stringify({ bitcoin: { usd: 1 }, ethereum: { usd: 2500 } }), now).map((r) => r.currency)).toEqual(["ETH"]);
    expect(() => parseCoinGecko("{}", now)).toThrow(FxSourceError);
    expect(() => parseCoinGecko("<html>", now)).toThrow(FxSourceError);
  });
});

describe("formatting", () => {
  const rates = new Map([
    ["EUR", { usdPerUnit18: 1_122_500_000_000_000_000n, source: "ECB" as const, rateAt: new Date() }],
    ["JPY", { usdPerUnit18: usd("0.0067"), source: "ECB" as const, rateAt: new Date() }],
    ["BTC", { usdPerUnit18: 65_000n * RATE_SCALE, source: "COINGECKO" as const, rateAt: new Date() }],
  ]);
  it("converts and formats per currency", () => {
    expect(formatCurrencyAmount(usdcIn(561_250_000n, "EUR", rates)!, "EUR", "en")).toBe("€500.00");
    expect(formatCurrencyAmount(usdcIn(100_000_000n, "JPY", rates)!, "JPY", "en")).toBe("¥14,925");
    expect(formatCurrencyAmount(usdcIn(561_250_000n, "BTC", rates)!, "BTC", "en")).toBe("0.00863462 BTC");
    expect(formatCurrencyAmount("1234567.89", "CHF", "en").replace(/\u00a0/g, " ")).toBe("CHF 1,234,567.89");
    // A decimal string keeps digits a float would lose.
    expect(formatCurrencyAmount("90071992547409.93", "USD", "en")).toBe("$90,071,992,547,409.93");
    expect(usdcIn(1n, "GBP", rates)).toBeNull(); // no rate → no conversion
    // €500 at 1.1225 → 561.25 USDC
    expect(eurCentsAsUsdc(50_000n, rates)).toBe(561_250_000n);
    expect(roundScaled(convertUsdc(eurCentsAsUsdc(50_000n, rates)!, rates.get("EUR")!.usdPerUnit18), 2)).toBe("500.00");
  });
});

describe("rates in Postgres (lazy refresh, staleness)", () => {
  const db = () => getDb();
  let calls: { ecb: number; crypto: number };
  let now: Date;
  let ecbResult: () => Promise<SourceRate[]>;
  let cryptoResult: () => Promise<SourceRate[]>;
  let scheduled: (() => Promise<void>)[];
  const deps = (): FxDeps => ({
    fetchEcb: () => (calls.ecb++, ecbResult()),
    fetchCrypto: () => (calls.crypto++, cryptoResult()),
    now: () => now,
    schedule: (work) => void scheduled.push(work),
  });
  const runScheduled = async () => {
    for (const work of scheduled.splice(0)) await work();
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("display-currency tests need DATABASE_URL");
    await db().execute(sql`select 1`);
  });
  beforeEach(async () => {
    await db().delete(fxRates);
    resetFxMemory();
    calls = { ecb: 0, crypto: 0 };
    scheduled = [];
    now = new Date("2026-10-03T10:00:00Z");
    ecbResult = async () => parseEcbAll(ECB.replace("2026-10-01", "2026-10-02"));
    cryptoResult = async () => parseCoinGecko(GECKO.replace(/1759400000/g, "1759485000"), now);
  });
  afterAll(async () => {
    await db().delete(fxRates);
    resetFxMemory();
  });

  it("first use waits for both sources and stores them; later uses refresh after the response", async () => {
    const first = await getDisplayRates(db(), deps());
    expect(calls).toEqual({ ecb: 1, crypto: 1 });
    expect(first.get("CHF")).toBeDefined();
    expect(first.get("BTC")!.usdPerUnit18).toBe(65_000n * RATE_SCALE);
    expect(first.get("USDC")!.usdPerUnit18).toBe(RATE_SCALE);
    expect((await db().select().from(fxRates)).length).toBeGreaterThan(10);

    // 10 minutes later: CoinGecko is due (5 min), the ECB is not (1 h); nothing waits.
    now = new Date(now.getTime() + 10 * 60_000);
    resetFxMemory();
    await getDisplayRates(db(), deps());
    expect(calls).toEqual({ ecb: 1, crypto: 1 });
    expect(scheduled).toHaveLength(1);
    await runScheduled();
    expect(calls).toEqual({ ecb: 1, crypto: 2 });
  });

  it("a failed refresh keeps the old values and is not retried at once", async () => {
    await getDisplayRates(db(), deps());
    now = new Date(now.getTime() + 2 * 60 * 60_000); // both due
    resetFxMemory();
    ecbResult = async () => {
      throw new FxSourceError("HTTP 503");
    };
    cryptoResult = ecbResult;
    const before = (await db().select().from(fxRates).where(eq(fxRates.currency, "CHF")))[0]!;
    await getDisplayRates(db(), deps());
    await runScheduled();
    const after = (await db().select().from(fxRates).where(eq(fxRates.currency, "CHF")))[0]!;
    expect(after.usdPerUnit).toBe(before.usdPerUnit);
    await getDisplayRates(db(), deps()); // within the retry pause: nothing scheduled
    expect(scheduled).toHaveLength(0);
  });

  it("stale rates are not shown: fiat older than 7 days, crypto fetched more than 1 hour ago", async () => {
    await getDisplayRates(db(), deps());
    ecbResult = async () => {
      throw new FxSourceError("down");
    };
    cryptoResult = ecbResult;
    now = new Date(now.getTime() + 61 * 60_000);
    resetFxMemory();
    const later = await getDisplayRates(db(), deps());
    expect(later.get("BTC")).toBeUndefined(); // crypto fetched 61 minutes ago
    expect(later.get("CHF")).toBeDefined(); // ECB date 2026-10-02, still fresh
    now = new Date("2026-10-09T00:00:01Z"); // more than 7 days after the ECB date
    resetFxMemory();
    const week = await getDisplayRates(db(), deps());
    expect(week.get("CHF")).toBeUndefined();
    expect(week.get("USD")!.usdPerUnit18).toBe(RATE_SCALE); // USD and USDC never go stale
    expect(FX_POLICY.cryptoMaxAgeMs).toBe(60 * 60_000);
  });
});

describe("PUT /api/preferences/currency", () => {
  beforeAll(() => {
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });
  beforeEach(() => preferencesRateLimiter.reset());
  afterAll(() => cleanUp());

  const put = (body: unknown, headers: Record<string, string> = {}) =>
    currencyRoute(
      new Request(`${ORIGIN}/api/preferences/currency`, {
        method: "PUT",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    );

  it("sets the cookie for a visitor, and the profile for a logged-in user", async () => {
    const anonymous = await put({ currency: "CHF" });
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("set-cookie")).toMatch(/^cherrio_currency=CHF;.*Path=\/.*SameSite=lax/i);
    expect(anonymous.headers.get("set-cookie")).not.toMatch(/HttpOnly/i);

    const user = await createUser();
    expect((await put({ currency: "BTC" }, { cookie: user.cookie })).status).toBe(200);
    const [row] = await getDb().select({ c: users.displayCurrency }).from(users).where(eq(users.id, user.id));
    expect(row!.c).toBe("BTC");
  });

  it("refuses unknown currencies and foreign origins", async () => {
    for (const currency of ["XYZ", "chf", "", 5, null]) {
      const res = await put({ currency });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "currency_not_supported" });
    }
    expect((await put({ currency: "CHF" }, { Origin: "https://evil.example" })).status).toBe(403);
  });

  it("has every message the UI uses", () => {
    expect(messages.fx.label).toBeTruthy();
    expect(Object.keys(messages.fx.crypto).sort()).toEqual(["BTC", "ETH", "POL", "USDC"]);
    expect(messages.ui.footer.rates).toMatch(/ECB/);
  });
});
