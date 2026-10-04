"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useAddFunds } from "@privy-io/react-auth";
import { Address as AddressText, Button, Field } from "@cherrio/ui";
import { getAddress, type Address } from "viem";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";
import { addFundsOptions, checkTopUp, MIN_TOPUP_EUR, type FundingMode } from "@/lib/funding/topup";

// "Add money" box (TASK-036, ADR-051) for a CHERR.IO wallet (smart account):
// on a test network it points to Circle's test-USDC faucet; with an onramp
// switched on it opens Privy's funding flow (card → USDC on Polygon to the
// smart account). Minimum 20 €. Used on Account → wallets and in the donate
// panel when the wallet holds too little USDC.

const CIRCLE_FAUCET = "https://faucet.circle.com/";

export interface AddMoneyProps {
  /** The smart account that receives the USDC. */
  address: Address;
  mode: FundingMode;
  networkName: string;
  /** Whole euros to start with (a suggestion; the donor may change it). */
  suggestedEur?: number;
  /** Heading level inside the parent section. */
  headingLevel?: 2 | 3;
}

export function AddMoney(props: AddMoneyProps) {
  const t = useTranslations("funding");
  const tAddress = useTranslations("ui.address");
  if (props.mode.kind === "none") return null;
  const Heading = props.headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="ch-panel p-5 flex flex-col gap-3" aria-labelledby="add-money-title">
      <Heading id="add-money-title" className="text-lg font-display uppercase text-[var(--ink)] m-0">{t("title")}</Heading>
      {props.mode.kind === "faucet" ? (
        <>
          <p className="m-0 text-sm text-[var(--ink)]">{t("faucetText", { network: props.networkName })}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-bold">{t("yourAddress")}</span>
            {/* In full: it is pasted into the faucet, and the donor should be able to compare it. */}
            <AddressText address={getAddress(props.address)} leadChars={42} className="break-all" copyLabel={tAddress("copy")} copiedLabel={tAddress("copied")} />
          </div>
          <a className="ch-proof" href={CIRCLE_FAUCET} target="_blank" rel="noopener noreferrer">
            {t("faucetLink")}<span aria-hidden="true"> ↗</span>
          </a>
        </>
      ) : (
        <OnrampForm {...props} environment={props.mode.environment} />
      )}
    </section>
  );
}

function OnrampForm(props: AddMoneyProps & { environment: "sandbox" | "production" }) {
  const t = useTranslations("funding");
  const { isAvailable } = useAppAuth();
  // Privy's hooks need its provider; without a Privy app (E2E, a broken config) say so.
  if (!isAvailable) return <p className="m-0 text-sm text-[var(--ink)]" role="status">{t("unavailable")}</p>;
  return <PrivyOnramp {...props} />;
}

function PrivyOnramp(props: AddMoneyProps & { environment: "sandbox" | "production" }) {
  const t = useTranslations("funding");
  const { addFunds } = useAddFunds();
  const [input, setInput] = React.useState(String(Math.max(MIN_TOPUP_EUR, props.suggestedEur ?? MIN_TOPUP_EUR)));
  const [touched, setTouched] = React.useState(false);
  const [state, setState] = React.useState<"idle" | "busy" | "submitted" | "error">("idle");
  React.useEffect(() => {
    if (props.suggestedEur) setInput(String(Math.max(MIN_TOPUP_EUR, props.suggestedEur)));
  }, [props.suggestedEur]);

  const check = checkTopUp(input);
  const error = !check.ok && (touched || input !== "") ? t(`errors.${check.reason}`, { min: MIN_TOPUP_EUR }) : undefined;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!check.ok) return;
    setState("busy");
    try {
      await addFunds(addFundsOptions({ address: props.address, eur: check.eur, environment: props.environment }));
      setState("submitted");
    } catch (e) {
      // The donor closing the modal also lands here; the message invites a retry.
      console.error("[funding] addFunds", e);
      setState("error");
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <p className="m-0 text-sm text-[var(--ink)]">{t("onrampText", { min: MIN_TOPUP_EUR })}</p>
      {props.environment === "sandbox" && <p className="ch-notice m-0 text-sm">{t("sandbox")}</p>}
      <Field
        id="add-money-amount"
        label={t("amountLabel")}
        suffix="EUR"
        mono
        inputMode="numeric"
        autoComplete="off"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onBlur={() => setTouched(true)}
        hint={error ? undefined : t("amountHint", { min: MIN_TOPUP_EUR })}
        error={error}
        disabled={state === "busy"}
      />
      <div>
        <Button type="submit" variant="primary" disabled={state === "busy" || !check.ok}>{t("button")}</Button>
      </div>
      {state === "busy" && <p className="m-0 text-sm font-bold" role="status">{t("busy")}</p>}
      {state === "submitted" && <p className="m-0 text-sm font-bold" role="status">{t("submitted")}</p>}
      {state === "error" && <p className="m-0 text-sm font-bold" role="alert">{t("failed")}</p>}
    </form>
  );
}
