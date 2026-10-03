import { check, numeric, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema } from "./enums.js";

// ── fx_rates ─────────────────────────────────────────────────────────────────
// Display-only exchange rates (ADR-040): USD per one unit of a currency, from
// the ECB (fiat) or CoinGecko (crypto). Never used for money logic; one row per
// currency, overwritten by each refresh. Not personal data.
export const fxRates = appSchema.table("fx_rates", {
  currency:   varchar("currency", { length: 10 }).primaryKey(),
  usdPerUnit: numeric("usd_per_unit", { precision: 38, scale: 18 }).notNull(),
  source:     text("source").notNull(),
  /** The ECB rate date, or CoinGecko's last-updated time. */
  rateAt:     timestamp("rate_at", { withTimezone: true }).notNull(),
  fetchedAt:  timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("fx_rates_source", sql`${t.source} in ('ECB', 'COINGECKO')`),
  check("fx_rates_positive", sql`${t.usdPerUnit} > 0`),
]);
