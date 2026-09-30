import { bigint, char, index, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, onrampProviderEnum, onrampStatusEnum } from "./enums.js";
import { numeric78, uuidPk } from "./helpers.js";
import { campaigns } from "./campaigns.js";
import { users } from "./users.js";

// ── onramp_orders ─────────────────────────────────────────────────────────────
// Records Transak card-onramp orders. usdc_amount is numeric(78,0) → bigint.
// fiat_amount_cents: EUR/USD/etc in integer cents — never float.
export const onrampOrders = appSchema.table("onramp_orders", {
  id:              uuidPk(),
  userId:          uuid("user_id").notNull().references(() => users.id),
  provider:        onrampProviderEnum("provider").notNull().default("TRANSAK"),
  providerOrderId: text("provider_order_id").notNull().unique(),
  status:          onrampStatusEnum("status").notNull().default("PENDING"),
  /** Fiat amount in smallest currency unit (integer cents). Never float. */
  fiatAmountCents: bigint("fiat_amount_cents", { mode: "bigint" }).notNull(),
  /** ISO 4217 currency code, e.g. "EUR". */
  fiatCurrency:    char("fiat_currency", { length: 3 }).notNull(),
  /** USDC amount with 6-decimal precision stored as numeric(78,0) → bigint. */
  usdcAmount:      numeric78("usdc_amount").notNull(),
  /** Donor's wallet address that receives USDC. */
  walletAddress:   varchar("wallet_address", { length: 42 }).notNull(),
  /** Optional campaign the donor intends to fund after the onramp. */
  campaignId:      uuid("campaign_id").references(() => campaigns.id),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                     .$onUpdateFn(() => new Date()),
}, (t) => [
  index("onramp_orders_user_id_idx").on(t.userId),
  index("onramp_orders_campaign_id_idx").on(t.campaignId),
  check("onramp_orders_wallet_address_format",
    sql`${t.walletAddress} ~ '^0x[0-9a-f]{40}$'`),
]);
