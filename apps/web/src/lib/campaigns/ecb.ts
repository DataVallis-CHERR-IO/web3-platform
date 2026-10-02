import { parseAppEnv, parseRate, type EurUsdRate } from "@cherrio/shared";

// ECB euro reference rate (ADR-036): the EUR→USD rate a campaign target is
// converted with at approval. Official, free and keyless. The ECB publishes
// on working days around 16:00 CET; on weekends and holidays the file still
// carries the last published rate, which is the one we use.

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const TIMEOUT_MS = 5_000;
/** Older than this, the file is not today's reference any more (longest ECB closure is Easter, 4 days). */
const MAX_AGE_DAYS = 7;

export interface EcbRate {
  /** USD per 1 EUR, × 1e8 (campaigns.eur_usd_rate numeric(18,8)). */
  rate: EurUsdRate;
  /** The rate exactly as published, e.g. "1.1734". */
  text: string;
  /** The ECB rate date (00:00 UTC of that day). */
  date: Date;
}

/** The rate could not be fetched or the answer is not usable. Approval is refused (no manual rate). */
export class EcbRateUnavailableError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`ECB rate unavailable: ${reason}`, options);
    this.name = "EcbRateUnavailableError";
  }
}

/**
 * The URL to fetch. `ECB_RATES_URL` is honoured only when APP_ENV=local
 * (tests and E2E serve a fixture); every deployed environment uses the ECB.
 */
export function ecbRatesUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ECB_RATES_URL;
  if (override && env.APP_ENV && parseAppEnv(env.APP_ENV) === "local") return override;
  return ECB_DAILY_URL;
}

/**
 * Reads the USD rate and its date from the ECB daily file
 * (`<Cube time='YYYY-MM-DD'><Cube currency='USD' rate='1.1734'/>…`).
 */
export function parseEcbDaily(xml: string, now: Date = new Date()): EcbRate {
  const time = /<Cube\s+time\s*=\s*["'](\d{4}-\d{2}-\d{2})["']/.exec(xml)?.[1];
  const text = /<Cube\s+currency\s*=\s*["']USD["']\s+rate\s*=\s*["']([^"']*)["']/.exec(xml)?.[1];
  if (!time) throw new EcbRateUnavailableError("no rate date in the answer");
  if (!text) throw new EcbRateUnavailableError("no USD rate in the answer");
  if (!/^\d{1,2}\.\d{1,8}$/.test(text)) throw new EcbRateUnavailableError(`unexpected USD rate "${text}"`);

  const rate = parseRate(text);
  // A sanity band far outside anything EUR/USD has done; a value outside it is a broken answer.
  if (rate < 50_000_000n || rate > 300_000_000n) throw new EcbRateUnavailableError(`implausible USD rate "${text}"`);

  const date = new Date(`${time}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new EcbRateUnavailableError(`invalid rate date "${time}"`);
  const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
  if (ageDays > MAX_AGE_DAYS) throw new EcbRateUnavailableError(`rate date ${time} is too old`);
  if (ageDays < -1) throw new EcbRateUnavailableError(`rate date ${time} is in the future`);

  return { rate, text, date };
}

/** Fetches the latest ECB EUR→USD reference rate. Throws EcbRateUnavailableError on any failure. */
export async function fetchEcbUsdRate(
  fetchImpl: typeof fetch = fetch,
  url: string = ecbRatesUrl(),
  now: Date = new Date()
): Promise<EcbRate> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch (cause) {
    throw new EcbRateUnavailableError("request failed", { cause });
  }
  if (!response.ok) throw new EcbRateUnavailableError(`HTTP ${response.status}`);
  const body = await response.text().catch((cause) => {
    throw new EcbRateUnavailableError("could not read the answer", { cause });
  });
  return parseEcbDaily(body, now);
}
