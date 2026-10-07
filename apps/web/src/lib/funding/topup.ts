import { POLYGON_CHAIN_ID, POLYGON_USDC_ADDRESS, type Address } from "@cherrio/shared";

// "Add money" (TASK-036, ADR-051): a CHERR.IO wallet is topped up once with a
// card through Privy's funding flow (Stripe, Coinbase; Transak as fallback),
// then the donor gives from it as usual. Pure rules here; the component is
// components/funding/AddMoney.tsx.

const RATE_SCALE_18 = 10n ** 18n;

/** Smallest top-up CHERR.IO offers (ADR-051 §3): providers' fixed fees would eat a small one. */
export const MIN_TOPUP_EUR = 20;
/** Sanity cap for the field; the providers apply their own limits. */
export const MAX_TOPUP_EUR = 10_000;
/** Added to a missing amount so the provider's fee does not leave the donor short again. */
export const FEE_BUFFER_PERCENT = 5n;

export const FUNDING_ONRAMP_SETTINGS = ["off", "sandbox", "production"] as const;
export type FundingOnrampSetting = (typeof FUNDING_ONRAMP_SETTINGS)[number];

/** `FUNDING_ONRAMP` (server env), anything unknown or missing → off. */
export function parseFundingOnramp(value: string | undefined): FundingOnrampSetting {
  return (FUNDING_ONRAMP_SETTINGS as readonly string[]).includes(value ?? "") ? (value as FundingOnrampSetting) : "off";
}

export type FundingMode =
  | { kind: "none" }
  /** Test network: free test USDC from Circle's faucet. */
  | { kind: "faucet" }
  /** `faucet`: a test network keeps the faucet next to the sandbox flow (nothing arrives through the sandbox). */
  | { kind: "onramp"; environment: "sandbox" | "production"; faucet: boolean };

/**
 * What the "Add money" box offers. A test network never gets a real onramp
 * (nothing delivers testnet USDC); `sandbox` there only exercises the card
 * flow, so the faucet stays below it — test USDC is what testers donate with.
 */
export function fundingMode(input: { testnet: boolean; onramp: FundingOnrampSetting }): FundingMode {
  if (input.onramp === "sandbox") return { kind: "onramp", environment: "sandbox", faucet: input.testnet };
  if (input.testnet) return { kind: "faucet" };
  if (input.onramp === "production") return { kind: "onramp", environment: "production", faucet: false };
  return { kind: "none" };
}

export type TopUpCheck = { ok: true; eur: number } | { ok: false; reason: "invalid" | "below_minimum" | "above_maximum" };

/** The amount field: whole euros, 20 – 10,000. */
export function checkTopUp(input: string): TopUpCheck {
  const s = input.trim();
  if (!/^\d{1,6}$/.test(s)) return { ok: false, reason: "invalid" };
  const eur = Number(s);
  if (eur < MIN_TOPUP_EUR) return { ok: false, reason: "below_minimum" };
  if (eur > MAX_TOPUP_EUR) return { ok: false, reason: "above_maximum" };
  return { ok: true, eur };
}

/**
 * Suggested top-up for a missing USDC amount: in EUR at the campaign's rate,
 * plus 5 % for the provider's fee, always up to whole euros, at least 20 €.
 * Without a rate (USDC mode) USDC is counted 1:1 as euros — only a suggestion.
 */
export function suggestTopUpEur(missingUsdc: bigint, usdPerEur18: bigint | null): number {
  if (missingUsdc <= 0n) return MIN_TOPUP_EUR;
  // EUR cents = USDC units × 1e18 / (10,000 × usdPerEur18), ceiling.
  const cents = usdPerEur18 && usdPerEur18 > 0n
    ? ceilDiv(missingUsdc * RATE_SCALE_18, 10_000n * usdPerEur18)
    : ceilDiv(missingUsdc, 10_000n);
  const withFee = ceilDiv(cents * (100n + FEE_BUFFER_PERCENT), 100n);
  const eur = Number(ceilDiv(withFee, 100n));
  return Math.min(MAX_TOPUP_EUR, Math.max(MIN_TOPUP_EUR, eur));
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * Card currencies offered in the funding flow. Privy's client-side Stripe
 * onramp takes USD and EUR without an extra KYB (Meld would add more); a
 * currency no enabled provider takes would end in an empty provider list.
 */
export const TOPUP_FIAT_CURRENCIES = ["eur", "usd"] as const;

/**
 * Options for Privy's `useAddFunds().addFunds`: USDC on Polygon to the smart
 * account, the amount in EUR as the default. Always Polygon mainnet — the
 * onramps deliver nothing on Amoy; the sandbox only runs the flow.
 */
export function addFundsOptions(input: { address: Address; eur: number; environment: "sandbox" | "production" }) {
  return {
    destination: { address: input.address, chain: `eip155:${POLYGON_CHAIN_ID}` as const, asset: POLYGON_USDC_ADDRESS },
    fiat: {
      source: { defaultAsset: "eur" as const, assets: [...TOPUP_FIAT_CURRENCIES] },
      defaultAmount: String(input.eur),
      environment: input.environment,
    },
  };
}

/** Server side: the mode for this deployment (`FUNDING_ONRAMP`, the chain's testnet flag). */
export function fundingModeFromEnv(testnet: boolean, setting: string | undefined = process.env.FUNDING_ONRAMP): FundingMode {
  return fundingMode({ testnet, onramp: parseFundingOnramp(setting) });
}
