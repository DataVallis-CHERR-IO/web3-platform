// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { PrivyClientProvider } from "@/components/auth/PrivyClientProvider";
import { privyLegalConfig } from "@/lib/auth/legal-links";

// TASK-050: the Privy sign-in window shows "By logging in I agree to the Terms
// and Privacy Policy" because the provider passes `legal` links. E2E has no
// Privy app, so the config handed to PrivyProvider is checked here.

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@cherrio/ui", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const captured: { config?: Record<string, unknown> } = {};

vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({
    children,
    config,
  }: {
    children: React.ReactNode;
    config: Record<string, unknown>;
  }) => {
    captured.config = config;
    return <>{children}</>;
  },
  usePrivy: () => ({
    ready: false,
    authenticated: false,
    user: null,
    getAccessToken: async () => "",
    login: () => {},
    logout: async () => {},
    unlinkWallet: async () => {},
  }),
  useLinkAccount: () => ({ linkWallet: vi.fn() }),
}));

vi.mock("@privy-io/react-auth/smart-wallets", () => ({
  SmartWalletsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSmartWallets: () => ({ client: undefined }),
}));

afterEach(() => {
  cleanup();
  captured.config = undefined;
});

describe("privyLegalConfig", () => {
  it("builds absolute Terms and Privacy links for the locale", () => {
    expect(privyLegalConfig("https://dev.cherr.io", "en")).toEqual({
      termsAndConditionsUrl: "https://dev.cherr.io/en/terms",
      privacyPolicyUrl: "https://dev.cherr.io/en/privacy",
    });
  });

  it("drops a trailing slash on the origin", () => {
    expect(privyLegalConfig("https://app.cherr.io/", "en").privacyPolicyUrl).toBe(
      "https://app.cherr.io/en/privacy",
    );
  });
});

describe("PrivyClientProvider legal links", () => {
  it("passes the page's Terms and Privacy links to the Privy sign-in window", () => {
    render(
      <PrivyClientProvider privyAppId="test-app" appEnv="dev" locale="en">
        <span>child</span>
      </PrivyClientProvider>,
    );
    const origin = window.location.origin;
    expect(captured.config?.legal).toEqual({
      termsAndConditionsUrl: `${origin}/en/terms`,
      privacyPolicyUrl: `${origin}/en/privacy`,
    });
  });

  it("defaults to the English pages when no locale is given", () => {
    render(
      <PrivyClientProvider privyAppId="test-app" appEnv="dev">
        <span>child</span>
      </PrivyClientProvider>,
    );
    expect(captured.config?.legal).toMatchObject({
      termsAndConditionsUrl: expect.stringMatching(/\/en\/terms$/),
    });
  });
});
