/**
 * Unit test: /dev/ui page guard rejects non-local/dev APP_ENV values.
 * The page calls notFound() when APP_ENV is not "local" or "dev".
 */
import { describe, it, expect } from "vitest";

/**
 * Extracted guard logic from apps/web/src/app/[locale]/dev/ui/page.tsx.
 * This mirrors the condition: allow only when APP_ENV is "local" or "dev".
 */
function shouldShowDevUi(appEnv: string | undefined): boolean {
  const env = appEnv ?? "prod";
  return env === "local" || env === "dev";
}

describe("/dev/ui APP_ENV guard", () => {
  it("allows APP_ENV=local", () => {
    expect(shouldShowDevUi("local")).toBe(true);
  });

  it("allows APP_ENV=dev", () => {
    expect(shouldShowDevUi("dev")).toBe(true);
  });

  it("blocks APP_ENV=uat (returns 404)", () => {
    expect(shouldShowDevUi("uat")).toBe(false);
  });

  it("blocks APP_ENV=prod (returns 404)", () => {
    expect(shouldShowDevUi("prod")).toBe(false);
  });

  it("blocks undefined APP_ENV (defaults to prod)", () => {
    expect(shouldShowDevUi(undefined)).toBe(false);
  });

  it("blocks invalid APP_ENV values", () => {
    expect(shouldShowDevUi("staging")).toBe(false);
    expect(shouldShowDevUi("production")).toBe(false);
    expect(shouldShowDevUi("development")).toBe(false);
  });
});
