import type { MarketCapProfile } from "./profile";

// Register facts on an organisation profile (TASK-017c): pure, so malformed values can be tested.

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The register facts we show, in order, as label key → text. */
export function registryFacts(p: MarketCapProfile, locale: string): [string, string][] {
  const raw = p.registryRecord ?? {};
  const money = (currency: string) => (v: unknown) => {
    const n = num(v);
    return n === null ? null : new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  };
  // Register values may be malformed ("2023-02-30", "201913"): an invalid date shows nothing instead of failing the page.
  const format = (iso: string, options: Intl.DateTimeFormatOptions) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso
      ? null
      : new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(d);
  };
  const date = (v: unknown) => {
    const d = str(v);
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? format(d, { dateStyle: "medium" }) : null;
  };
  const month = (v: unknown) => {
    const d = str(v);
    return d && /^\d{6}$/.test(d) ? format(`${d.slice(0, 4)}-${d.slice(4)}-01`, { year: "numeric", month: "long" }) : null;
  };
  const out: [string, string | null][] = [];
  if (p.registry === "UK_CC") {
    const gbp = money("GBP");
    out.push(["number", p.registryId], ["status", str(raw.status)], ["registeredOn", date(raw.registeredOn)], ["removedOn", date(raw.removedOn)],
      ["financialYearEnd", date(raw.financialYearEnd)], ["income", gbp(raw.income)], ["expenditure", gbp(raw.expenditure)]);
  } else if (p.registry === "US_IRS") {
    const usd = money("USD");
    const location = [str(raw.city), str(raw.state)].filter(Boolean).join(", ") || null;
    out.push(["ein", p.registryId], ["location", location], ["ruling", month(raw.ruling)], ["taxPeriod", month(raw.taxPeriod)],
      ["revenue", usd(raw.revenue)], ["assets", usd(raw.assets)]);
  } else if (p.registry !== "NONE") {
    out.push(["number", p.registryId]);
  }
  return out.filter((f): f is [string, string] => f[1] !== null);
}
