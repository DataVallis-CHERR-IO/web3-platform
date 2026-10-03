import { RATE_SCALE, parseAppEnv, parseScaled18 } from "@cherrio/shared";
import { ecbRatesUrl } from "@/lib/campaigns/ecb";

// Sources of the display-only exchange rates (ADR-040). Both return "USD per
// one unit" × 10^18 per currency code, with 1 USDC = 1 USD (ADR-036).

export interface SourceRate {
  currency: string;
  usdPerUnit18: bigint;
  rateAt: Date;
}

export class FxSourceError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`exchange-rate source unavailable: ${reason}`, options);
    this.name = "FxSourceError";
  }
}

const TIMEOUT_MS = 5_000;

async function fetchText(fetchImpl: typeof fetch, url: string, headers?: Record<string, string>): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store", headers });
  } catch (cause) {
    throw new FxSourceError("request failed", { cause });
  }
  if (!response.ok) throw new FxSourceError(`HTTP ${response.status}`);
  try {
    return await response.text();
  } catch (cause) {
    throw new FxSourceError("could not read the answer", { cause });
  }
}

/**
 * Every currency of the ECB daily file, as USD per unit: `USD per X = (USD per EUR) ÷ (X per EUR)`,
 * and EUR itself = USD per EUR. Rates that are not plain positive decimals are skipped.
 */
export function parseEcbAll(xml: string): SourceRate[] {
  const time = /<Cube\s+time\s*=\s*["'](\d{4}-\d{2}-\d{2})["']/.exec(xml)?.[1];
  if (!time) throw new FxSourceError("no rate date in the ECB answer");
  const rateAt = new Date(`${time}T00:00:00Z`);
  if (Number.isNaN(rateAt.getTime())) throw new FxSourceError(`invalid ECB rate date "${time}"`);

  const perEur = new Map<string, bigint>();
  for (const match of xml.matchAll(/<Cube\s+currency\s*=\s*["']([A-Z]{3})["']\s+rate\s*=\s*["']([^"']*)["']/g)) {
    const value = parseScaled18(match[2]!);
    if (value !== null) perEur.set(match[1]!, value);
  }
  const usdPerEur = perEur.get("USD");
  if (!usdPerEur) throw new FxSourceError("no USD rate in the ECB answer");

  const rates: SourceRate[] = [{ currency: "EUR", usdPerUnit18: usdPerEur, rateAt }];
  for (const [currency, xPerEur] of perEur) {
    if (currency === "USD") rates.push({ currency, usdPerUnit18: RATE_SCALE, rateAt });
    else rates.push({ currency, usdPerUnit18: (usdPerEur * RATE_SCALE) / xPerEur, rateAt });
  }
  return rates.filter((r) => r.usdPerUnit18 > 0n);
}

export async function fetchEcbRates(fetchImpl: typeof fetch = fetch, url: string = ecbRatesUrl()): Promise<SourceRate[]> {
  return parseEcbAll(await fetchText(fetchImpl, url));
}

// CoinGecko ids of the crypto currencies we show (USDC is 1 USD by definition, not fetched).
export const COINGECKO_IDS: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  POL: "polygon-ecosystem-token",
};
// Sanity bands in USD; a price outside is a broken answer, not a market move.
const BANDS: Readonly<Record<string, [bigint, bigint]>> = {
  BTC: [100n * RATE_SCALE, 100_000_000n * RATE_SCALE],
  ETH: [1n * RATE_SCALE, 10_000_000n * RATE_SCALE],
  POL: [RATE_SCALE / 100_000n, 10_000n * RATE_SCALE],
};

export const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price";

/** `COINGECKO_URL` is honoured only when APP_ENV=local (tests); deployed environments use CoinGecko. */
export function coinGeckoUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COINGECKO_URL;
  const base = override && env.APP_ENV && parseAppEnv(env.APP_ENV) === "local" ? override : COINGECKO_URL;
  const ids = Object.values(COINGECKO_IDS).join(",");
  return `${base}?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`;
}

/**
 * Parses `{"bitcoin":{"usd":65000.12,"last_updated_at":1759400000}, …}`. Prices are read from the
 * JSON text as written (no float), so the stored rate is exactly what CoinGecko sent.
 */
export function parseCoinGecko(json: string, now: Date = new Date()): SourceRate[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (cause) {
    throw new FxSourceError("CoinGecko answer is not JSON", { cause });
  }
  if (!data || typeof data !== "object") throw new FxSourceError("unexpected CoinGecko answer");
  const rates: SourceRate[] = [];
  for (const [currency, id] of Object.entries(COINGECKO_IDS)) {
    if (!(id in data)) continue;
    // The price as written in the JSON text: "<id>":{ … "usd":<number> … }
    const block = new RegExp(`"${id}"\\s*:\\s*\\{([^}]*)\\}`).exec(json)?.[1] ?? "";
    const price = /"usd"\s*:\s*([0-9.eE+-]+)/.exec(block)?.[1];
    const updated = /"last_updated_at"\s*:\s*(\d{9,11})/.exec(block)?.[1];
    const value = price ? parseScaled18(price) : null;
    const [min, max] = BANDS[currency]!;
    if (value === null || value < min || value > max) continue;
    const rateAt = updated ? new Date(Number(updated) * 1000) : now;
    rates.push({ currency, usdPerUnit18: value, rateAt: rateAt > now ? now : rateAt });
  }
  if (rates.length === 0) throw new FxSourceError("no usable price in the CoinGecko answer");
  return rates;
}

export async function fetchCryptoRates(
  fetchImpl: typeof fetch = fetch,
  url: string = coinGeckoUrl(),
  apiKey: string | undefined = process.env.COINGECKO_DEMO_API_KEY,
  now: Date = new Date()
): Promise<SourceRate[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;
  return parseCoinGecko(await fetchText(fetchImpl, url, headers), now);
}
