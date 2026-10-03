import { DISPLAY_CURRENCY_COOKIE } from "@cherrio/shared";

/** The display-currency cookie (ADR-040): not secret, read by the page's selector too, so not httpOnly. */
export function displayCurrencyCookie(currency: string) {
  return {
    name: DISPLAY_CURRENCY_COOKIE,
    value: currency,
    httpOnly: false,
    secure: process.env.APP_ENV !== "local",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  };
}
