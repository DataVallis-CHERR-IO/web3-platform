/** @vitest-environment jsdom */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, cleanup } from "@testing-library/react";
import { PrivyClientProvider, useAppAuth } from "@/components/auth/PrivyClientProvider";

// Mock next-intl
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Mock @cherrio/ui toast
vi.mock("@cherrio/ui", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Mock privy react-auth
let currentPrivyState: {
  ready: boolean;
  authenticated: boolean;
  user: { id: string; email?: { address: string } } | null;
  getAccessToken: () => Promise<string>;
  login: () => void;
  logout: () => Promise<void>;
  unlinkWallet: (addr: string) => Promise<void>;
};

vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePrivy: () => currentPrivyState,
  useLinkAccount: () => ({ linkWallet: vi.fn() }),
}));

function ConsumerComponent() {
  const { user, isAuthenticated } = useAppAuth();
  return (
    <div>
      <span data-testid="auth">{isAuthenticated ? "logged-in" : "logged-out"}</span>
      <span data-testid="user">{user?.displayName ?? "none"}</span>
    </div>
  );
}

describe("PrivyClientProvider session sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("does NOT trigger a second POST /api/auth/session when privyUser object changes with the same id", async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/auth/session") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              user: {
                id: "db-user-1",
                displayName: "Supporter 1234",
                email: "test@example.com",
                roles: [],
                addresses: [],
                anonymousDonations: false,
                locale: "en",
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    currentPrivyState = {
      ready: true,
      authenticated: true,
      user: { id: "did:privy:12345", email: { address: "test@example.com" } },
      getAccessToken: vi.fn().mockResolvedValue("mock_token_1"),
      login: vi.fn(),
      logout: vi.fn(),
      unlinkWallet: vi.fn(),
    };

    const { rerender } = render(
      <PrivyClientProvider privyAppId="cmup9dfcd00ct0cjsvqkzm9q9" appEnv="local">
        <ConsumerComponent />
      </PrivyClientProvider>
    );

    // Initial session creation call
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/auth/session",
        expect.objectContaining({ method: "POST" })
      );
    });

    const sessionPostCallsBefore = fetchSpy.mock.calls.filter(
      (c) => c[0] === "/api/auth/session" && (c[1] as RequestInit)?.method === "POST"
    ).length;

    expect(sessionPostCallsBefore).toBe(1);

    // Now change the privyUser object reference (e.g. background refresh) with the EXACT SAME ID
    await act(async () => {
      currentPrivyState = {
        ...currentPrivyState,
        user: { id: "did:privy:12345", email: { address: "test@example.com" } }, // new object reference
      };
      rerender(
        <PrivyClientProvider privyAppId="cmup9dfcd00ct0cjsvqkzm9q9" appEnv="local">
          <ConsumerComponent />
        </PrivyClientProvider>
      );
    });

    // Check that NO second POST /api/auth/session was dispatched
    const sessionPostCallsAfter = fetchSpy.mock.calls.filter(
      (c) => c[0] === "/api/auth/session" && (c[1] as RequestInit)?.method === "POST"
    ).length;

    expect(sessionPostCallsAfter).toBe(1);
  });
});
