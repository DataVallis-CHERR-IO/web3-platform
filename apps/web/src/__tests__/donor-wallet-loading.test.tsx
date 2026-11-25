// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { WithDonorWallet } from "@/components/wallet/DonorWallet";

// Agents' run 45628316062: while Privy loads, the donate box said "Donating is not
// available right now" — a first-time visitor reads that as an outage.

const auth = { isAvailable: true, isAuthenticated: false, isLoading: true, login: vi.fn() };
vi.mock("@/components/auth/PrivyClientProvider", () => ({ useAppAuth: () => auth }));
vi.mock("@privy-io/react-auth", () => ({ useWallets: () => ({ wallets: [], ready: false }) }));
vi.mock("@privy-io/react-auth/smart-wallets", () => ({ useSmartWallets: () => ({ client: undefined, getClientForChain: vi.fn() }) }));

const show = () =>
  render(<WithDonorWallet appEnv="dev" chainId={80002}>{(w) => <p>{w.kind}</p>}</WithDonorWallet>);

afterEach(() => cleanup());

describe("donor wallet state while Privy loads", () => {
  it("is preparing, not unavailable", () => {
    auth.isLoading = true;
    show();
    expect(screen.getByText("preparing")).toBeTruthy();
  });

  it("is logged_out once Privy has loaded and nobody is signed in", () => {
    auth.isLoading = false;
    show();
    expect(screen.getByText("logged_out")).toBeTruthy();
  });
});
