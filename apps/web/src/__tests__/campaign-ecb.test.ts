import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ECB_DAILY_URL, EcbRateUnavailableError, ecbRatesUrl, fetchEcbUsdRate, parseEcbDaily } from "@/lib/campaigns/ecb";

// The ECB client (ADR-036) against a fixture in the published file format. No live network.

const FIXTURE = readFileSync(join(__dirname, "fixtures/ecb-eurofxref-daily.xml"), "utf8");
const RATE_DAY = new Date("2026-10-01T00:00:00Z");
const atDay = (days: number) => new Date(RATE_DAY.getTime() + days * 86_400_000 + 18 * 3_600_000);
const answer = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("ECB daily reference rate", () => {
  it("reads the USD rate and the rate date from the published format", () => {
    const parsed = parseEcbDaily(FIXTURE, atDay(0));
    expect(parsed).toEqual({ rate: 117_340_000n, text: "1.1734", date: RATE_DAY });
  });

  it("accepts the last published rate over a weekend or a holiday, refuses a stale or future one", () => {
    expect(parseEcbDaily(FIXTURE, atDay(4)).rate).toBe(117_340_000n); // Friday's rate on Tuesday after Easter
    expect(() => parseEcbDaily(FIXTURE, atDay(8))).toThrow(/too old/);
    expect(() => parseEcbDaily(FIXTURE, atDay(-3))).toThrow(/in the future/);
  });

  it("refuses an answer without a USD rate, without a date, or with a broken value", () => {
    const now = atDay(0);
    expect(() => parseEcbDaily(FIXTURE.replace("currency='USD'", "currency='XXX'"), now)).toThrow(EcbRateUnavailableError);
    expect(() => parseEcbDaily(FIXTURE.replace("time='2026-10-01'", ""), now)).toThrow(/no rate date/);
    expect(() => parseEcbDaily(FIXTURE.replace("rate='1.1734'", "rate='N/A'"), now)).toThrow(/unexpected USD rate/);
    expect(() => parseEcbDaily(FIXTURE.replace("rate='1.1734'", "rate='3.5'"), now)).toThrow(/implausible/);
    expect(() => parseEcbDaily(FIXTURE.replace("rate='1.1734'", "rate='1.123456789'"), now)).toThrow(/unexpected/);
    expect(() => parseEcbDaily("<html>Service unavailable</html>", now)).toThrow(EcbRateUnavailableError);
  });

  it("fetch: a network failure or an HTTP error becomes EcbRateUnavailableError", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchEcbUsdRate(failing, ECB_DAILY_URL, atDay(0))).rejects.toThrow(/request failed/);
    await expect(fetchEcbUsdRate(answer("busy", 503), ECB_DAILY_URL, atDay(0))).rejects.toThrow(/HTTP 503/);
    await expect(fetchEcbUsdRate(answer(FIXTURE), ECB_DAILY_URL, atDay(0))).resolves.toMatchObject({ text: "1.1734" });
  });

  it("ECB_RATES_URL is honoured only with APP_ENV=local", () => {
    const override = "http://127.0.0.1:4999/ecb.xml";
    expect(ecbRatesUrl({ APP_ENV: "local", ECB_RATES_URL: override } as unknown as NodeJS.ProcessEnv)).toBe(override);
    for (const appEnv of ["dev", "uat", "prod"]) {
      expect(ecbRatesUrl({ APP_ENV: appEnv, ECB_RATES_URL: override } as unknown as NodeJS.ProcessEnv)).toBe(ECB_DAILY_URL);
    }
    expect(ecbRatesUrl({ ECB_RATES_URL: override } as unknown as NodeJS.ProcessEnv)).toBe(ECB_DAILY_URL);
    expect(ecbRatesUrl({ APP_ENV: "local" } as unknown as NodeJS.ProcessEnv)).toBe(ECB_DAILY_URL);
  });
});
