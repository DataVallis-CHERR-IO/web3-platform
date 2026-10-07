// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddMoney } from "@/components/funding/AddMoney";
import { POLYGON_USDC_ADDRESS } from "@cherrio/shared";

// TASK-036b: dev runs the card flow in Privy's sandbox (FUNDING_ONRAMP=sandbox).
// Nothing arrives through the sandbox, so a test network keeps the faucet
// below the card form. E2E has no Privy app (the form says "unavailable"
// there), so the box and the options handed to Privy are checked here.

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@cherrio/ui", () => ({
  Address: ({ address }: { address: string }) => <span>{address}</span>,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => {
    const { variant: _variant, ...rest } = props;
    return <button {...rest} />;
  },
  Field: ({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: React.ChangeEventHandler<HTMLInputElement> }) => (
    <label htmlFor={id}>
      {label}
      <input id={id} value={value} onChange={onChange} />
    </label>
  ),
}));

const addFunds = vi.fn(async (_opts: unknown) => ({ method: "fiat", status: "submitted" }));
vi.mock("@privy-io/react-auth", () => ({ useAddFunds: () => ({ addFunds }) }));
vi.mock("@/components/auth/PrivyClientProvider", () => ({ useAppAuth: () => ({ isAvailable: true }) }));

const address = "0x1111111111111111111111111111111111111111" as const;

afterEach(() => {
  cleanup();
  addFunds.mockClear();
});

describe("AddMoney", () => {
  it("test network with the sandbox: card form, sandbox notice and the faucet below it", async () => {
    render(<AddMoney address={address} mode={{ kind: "onramp", environment: "sandbox", faucet: true }} networkName="Polygon Amoy" suggestedEur={25} />);
    expect(screen.getByText("sandbox")).toBeTruthy();
    expect(screen.getByRole("link", { name: /faucetLink/ }).getAttribute("href")).toBe("https://faucet.circle.com/");
    fireEvent.click(screen.getByRole("button", { name: "button" }));
    await waitFor(() => expect(addFunds).toHaveBeenCalledTimes(1));
    expect(addFunds.mock.calls[0]?.[0]).toEqual({
      destination: { address, chain: "eip155:137", asset: POLYGON_USDC_ADDRESS },
      fiat: { source: { defaultAsset: "eur", assets: ["eur", "usd"] }, defaultAmount: "25", environment: "sandbox" },
    });
  });

  it("mainnet production: the card form only, no faucet", () => {
    render(<AddMoney address={address} mode={{ kind: "onramp", environment: "production", faucet: false }} networkName="Polygon" />);
    expect(screen.getByRole("button", { name: "button" })).toBeTruthy();
    expect(screen.queryByText("sandbox")).toBeNull();
    expect(screen.queryByRole("link", { name: /faucetLink/ })).toBeNull();
  });

  it("test network without the sandbox: the faucet only", () => {
    render(<AddMoney address={address} mode={{ kind: "faucet" }} networkName="Polygon Amoy" />);
    expect(screen.getByRole("link", { name: /faucetLink/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "button" })).toBeNull();
  });
});
