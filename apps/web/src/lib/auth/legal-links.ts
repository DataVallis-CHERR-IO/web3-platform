/**
 * Links to the Terms and the Privacy Policy shown in the Privy sign-in window
 * (TASK-050, ADR-054). Privy renders them in the window's footer as
 * "By logging in I agree to the Terms and Privacy Policy"; the setting in code
 * overrides whatever is entered in the Privy dashboard, so every environment
 * links to its own pages.
 *
 * Absolute URLs: the links open from Privy's window, and the browser's own
 * origin is the public address (dev.cherr.io, app.cherr.io). Outside the
 * browser (server render) there is no window — the links are only used once
 * the sign-in window opens, which happens in the browser.
 */
export interface PrivyLegalConfig {
  termsAndConditionsUrl: string;
  privacyPolicyUrl: string;
}

export function privyLegalConfig(origin: string, locale: string): PrivyLegalConfig {
  const base = origin.replace(/\/+$/, "");
  const lang = encodeURIComponent(locale);
  return {
    termsAndConditionsUrl: `${base}/${lang}/terms`,
    privacyPolicyUrl: `${base}/${lang}/privacy`,
  };
}
