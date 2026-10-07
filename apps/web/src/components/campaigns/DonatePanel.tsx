"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useWallets } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { getAddress, type Address, type EIP1193Provider, type Hash } from "viem";
import { Button, Field, ProofLink } from "@cherrio/ui";
import { formatUsdc } from "@cherrio/shared/money";
import { useRouter } from "@/i18n/routing";
import { LabeledSelect } from "@/components/LabeledSelect";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";
import { AddMoney } from "@/components/funding/AddMoney";
import { suggestTopUpEur, type FundingMode } from "@/lib/funding/topup";
import { checkDonationAmount, QUICK_AMOUNTS_EUR_CENTS } from "@/lib/campaigns/donate";
import {
  changePreference, donate, donateWithSmartAccount, toDonateFailure, waitForTx,
  type DonateFailure, type DonateStep, type FailurePreference, type SendCalls,
} from "@/lib/campaigns/donate-client";

// Donate panel and "Your donation" box on the campaign page (TASK-011b/c).
// External wallet: two transactions in the donor's own wallet (EIP-1193 through
// Privy), gas in POL. Wallet created by CHERR.IO (Privy embedded): its ERC-4337
// smart account sends approve + donate as one user operation, gas sponsored
// (TASK-011c). Rules: lib/campaigns/donate.ts (amounts), donate-client.ts (chain).

export interface DonatePanelProps {
  campaign: Address;
  chainId: number;
  networkName: string;
  testnet: boolean;
  /** USDC units, decimal string (bigint over the RSC boundary). */
  remainingUsdc: string;
  /** USD per EUR × 1e18, decimal string; null → the field is in USDC. */
  usdPerEur18: string | null;
  themes: { poolId: number; name: string }[];
  /** e.g. https://amoy.polygonscan.com/tx/ — null on a local chain. */
  explorerTx: string | null;
  appEnv: string;
  /** "Add money" for a CHERR.IO wallet that holds too little USDC (TASK-036). */
  funding: FundingMode;
}

/** A wallet the panel can donate from. */
interface DonorWallet {
  /** The donor address on-chain (the smart account for a CHERR.IO wallet). */
  account: Address;
  /** EIP-1193 provider: reads, and signing on the two-transaction path. */
  provider: (chainId: number) => Promise<EIP1193Provider>;
  /** Smart account: sends calls as one sponsored user operation. */
  sendCalls?: SendCalls;
}

/** How long to wait for Privy's smart-account client before using the embedded wallet directly. */
const SMART_ACCOUNT_WAIT_MS = 8_000;

type WalletState =
  | { kind: "unavailable" }
  | { kind: "preparing" }
  | { kind: "logged_out"; login: () => void }
  | { kind: "no_wallet" }
  | { kind: "ready"; wallet: DonorWallet };

/** Test wallet for Playwright: honoured only when APP_ENV=local (never deployed). */
interface E2eWindow {
  __cherrioE2eWallet?: {
    address: string;
    provider: EIP1193Provider;
    /** Present → behaves like a smart account (one batched, sponsored call). */
    sendCalls?: SendCalls;
  };
}

const CIRCLE_FAUCET = "https://faucet.circle.com/";

/** Rejects with "timeout" when the wallet does not answer in time. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

export function DonatePanel(props: DonatePanelProps) {
  const { isAvailable } = useAppAuth();
  const [e2e, setE2e] = React.useState<DonorWallet | null>(null);
  React.useEffect(() => {
    if (props.appEnv !== "local") return;
    const injected = (window as unknown as E2eWindow).__cherrioE2eWallet;
    if (injected) {
      setE2e({ account: getAddress(injected.address), provider: async () => injected.provider, sendCalls: injected.sendCalls });
    }
  }, [props.appEnv]);

  if (isAvailable) return <PrivyDonate {...props} />;
  return <DonateUi {...props} wallet={e2e ? { kind: "ready", wallet: e2e } : { kind: "unavailable" }} />;
}

function PrivyDonate(props: DonatePanelProps) {
  const { isAuthenticated, isLoading, login } = useAppAuth();
  const { wallets, ready } = useWallets();
  const { client: smartClient, getClientForChain } = useSmartWallets();
  const [smartWaitOver, setSmartWaitOver] = React.useState(false);
  React.useEffect(() => {
    const timer = setTimeout(() => setSmartWaitOver(true), SMART_ACCOUNT_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  let state: WalletState;
  if (!isAuthenticated) state = isLoading ? { kind: "unavailable" } : { kind: "logged_out", login };
  else {
    // An external wallet first (it holds the donor's own USDC), else the one created by CHERR.IO.
    const external = wallets.find((w) => w.walletClientType !== "privy");
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    const chosen = external ?? embedded;
    const provider = (w: NonNullable<typeof chosen>) => async (chainId: number) => {
      await withTimeout(w.switchChain(chainId), 60_000).catch(() => undefined);
      return (await withTimeout(w.getEthereumProvider(), 20_000)) as EIP1193Provider;
    };
    const smartAddress = smartClient?.account?.address;
    if (!ready || !chosen) state = { kind: "no_wallet" };
    else if (!external && smartClient && smartAddress) {
      // CHERR.IO wallet → its smart account; reads through the embedded wallet.
      state = {
        kind: "ready",
        wallet: {
          account: getAddress(smartAddress),
          provider: provider(chosen),
          sendCalls: async (calls) => {
            const client = (await getClientForChain({ id: props.chainId })) ?? smartClient;
            return client.sendTransaction({ calls });
          },
        },
      };
    } else if (!external && !smartWaitOver) state = { kind: "preparing" };
    else state = { kind: "ready", wallet: { account: getAddress(chosen.address), provider: provider(chosen) } };
  }
  return <DonateUi {...props} wallet={state} />;
}

type Phase =
  | { kind: "form" }
  | { kind: "busy"; step: DonateStep | "mining"; tx?: Hash }
  | { kind: "done"; tx: Hash }
  | { kind: "error"; code: DonateFailure; tx?: Hash };

function DonateUi(props: DonatePanelProps & { wallet: WalletState }) {
  const t = useTranslations("campaignPage.donate");
  const router = useRouter();
  const mode: "EUR" | "USDC" = props.usdPerEur18 ? "EUR" : "USDC";
  const rate = props.usdPerEur18 ? BigInt(props.usdPerEur18) : null;
  const remaining = BigInt(props.remainingUsdc);
  const [input, setInput] = React.useState("25");
  const [touched, setTouched] = React.useState(false);
  const [pref, setPref] = React.useState<"REFUND" | "EMERGENCY_POOL">("REFUND");
  const [theme, setTheme] = React.useState("0");
  const [phase, setPhase] = React.useState<Phase>({ kind: "form" });
  const [refreshKey, setRefreshKey] = React.useState(0);

  const check = checkDonationAmount({ input, mode, usdPerEur18: rate, remainingUsdc: remaining });
  const error = !check.ok && (touched || input !== "")
    ? check.reason === "below_minimum"
      ? t(mode === "EUR" ? "errorMinimumEur" : "errorMinimumUsdc")
      : check.reason === "nothing_left" ? t("errorNothingLeft") : t("errorInvalid")
    : undefined;
  const preference: FailurePreference =
    pref === "REFUND" ? { kind: "REFUND" } : { kind: "EMERGENCY_POOL", subPoolId: Number(theme) };
  const busy = phase.kind === "busy";
  const usdcText = (units: bigint) => formatUsdc(units, { minDecimals: 2, maxDecimals: 6 });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (props.wallet.kind === "logged_out") return props.wallet.login();
    if (props.wallet.kind !== "ready" || !check.ok) return;
    rememberReferral(props.campaign);
    let tx: Hash | undefined;
    try {
      setPhase({ kind: "busy", step: "checking" });
      const { account, sendCalls } = props.wallet.wallet;
      const provider = await props.wallet.wallet.provider(props.chainId);
      const donateCall = { chainId: props.chainId, campaign: props.campaign, send: check.send, preference };
      const result = sendCalls
        ? await donateWithSmartAccount(provider, account, sendCalls, donateCall, (step) => setPhase({ kind: "busy", step }))
        : await donate(provider, account, donateCall, (step, detail) => setPhase({ kind: "busy", step, tx: detail?.approveTx }));
      tx = result.txHash;
      setPhase({ kind: "busy", step: "mining", tx });
      const ok = await waitForTx(provider, tx);
      setPhase(ok ? { kind: "done", tx } : { kind: "error", code: "reverted", tx });
      if (ok) {
        setRefreshKey((k) => k + 1);
        router.refresh();
      }
    } catch (e) {
      setPhase({ kind: "error", code: toDonateFailure(e), tx });
    }
  }

  const txLink = (tx: Hash, label: string) =>
    props.explorerTx ? (
      <ProofLink href={`${props.explorerTx}${tx}`} external>
        {label}
      </ProofLink>
    ) : (
      <span className="ch-mono text-sm break-all">{tx}</span>
    );

  if (props.wallet.kind === "unavailable" || props.wallet.kind === "preparing") {
    return (
      <div id="donate" className="ch-donate">
        <p className="m-0 text-sm" role="status">{t(props.wallet.kind === "preparing" ? "preparing" : "unavailable")}</p>
      </div>
    );
  }
  const sponsored = props.wallet.kind === "ready" && !!props.wallet.wallet.sendCalls;

  if (phase.kind === "done") {
    return (
      <div id="donate" className="ch-donate">
        <p className="m-0 font-bold" role="status">{t("success")}</p>
        {txLink(phase.tx, t("successProof"))}
        <Button variant="secondary" onClick={() => setPhase({ kind: "form" })}>{t("again")}</Button>
        <YourDonation {...props} refreshKey={refreshKey} />
      </div>
    );
  }

  const errorCode = phase.kind === "error"
    ? phase.code === "insufficient_usdc" && sponsored ? "insufficient_usdc_smart"
      : phase.code === "insufficient_usdc" && props.testnet ? "insufficient_usdc_testnet" : phase.code
    : null;
  const donorAddress = props.wallet.kind === "ready" ? props.wallet.wallet.account : "";

  return (
    <div id="donate" className="ch-donate">
      <form className="ch-donate-form" onSubmit={submit} noValidate>
        <h2 className="ch-label m-0">{t("title")}</h2>
        {mode === "EUR" && (
          <div className="ch-donate-quick" role="group" aria-label={t("quickAmounts")}>
            {QUICK_AMOUNTS_EUR_CENTS.map((cents) => {
              const value = (cents / 100n).toString();
              return (
                <Button
                  key={value}
                  type="button"
                  variant="secondary"
                  aria-pressed={input === value}
                  onClick={() => { setInput(value); setTouched(true); }}
                  disabled={busy}
                >
                  {t("quick", { amount: value })}
                </Button>
              );
            })}
          </div>
        )}
        <Field
          id="donate-amount"
          label={t("amountLabel")}
          suffix={mode}
          mono
          inputMode="decimal"
          autoComplete="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onBlur={() => setTouched(true)}
          hint={error ? undefined : t(mode === "EUR" ? "amountHintEur" : "amountHintUsdc")}
          error={error}
          disabled={busy}
        />
        {check.ok && check.clipped && (
          <p className="ch-notice m-0" role="status">{t("clipped", { amount: usdcText(check.usdc) })}</p>
        )}
        <details className="ch-donate-details">
          <summary>{t("details")}</summary>
          {check.ok && <p className="m-0">{t("detailsSend", { amount: usdcText(check.usdc) })}</p>}
          {rate !== null && (
            <p className="m-0">{t("detailsRate", { rate: usdcText((100n * 10_000n * rate) / 10n ** 18n) })}</p>
          )}
          <p className="m-0">{t("detailsMinimum")}</p>
          <p className="m-0">{t(sponsored ? "gasNoteSponsored" : "gasNote")}</p>
        </details>
        <fieldset className="ch-field ch-checkbox-group" disabled={busy}>
          <legend className="ch-label">{t("ifFails")}</legend>
          <div className="ch-donate-prefs">
            {(["REFUND", "EMERGENCY_POOL"] as const).map((value) => (
              <label key={value} className="ch-checkbox">
                <input type="radio" name="donate-pref" value={value} checked={pref === value} onChange={() => setPref(value)} />
                {t(value === "REFUND" ? "prefRefund" : "prefPool")}
              </label>
            ))}
          </div>
        </fieldset>
        {pref === "EMERGENCY_POOL" && props.themes.length > 0 && (
          <LabeledSelect
            label={t("theme")}
            placeholder={t("themeGeneral")}
            value={theme}
            onChange={setTheme}
            options={[{ value: "0", label: t("themeGeneral") }, ...props.themes.map((th) => ({ value: String(th.poolId), label: th.name }))]}
            disabled={busy}
          />
        )}
        {props.wallet.kind === "no_wallet" && <p className="ch-notice m-0">{t("noWallet")}</p>}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          disabled={busy || props.wallet.kind === "no_wallet" || (props.wallet.kind === "ready" && !check.ok)}
        >
          {props.wallet.kind === "logged_out" ? t("buttonLogin") : t("button")}
        </Button>
        {phase.kind === "busy" && (
          <p className="m-0 text-sm font-bold" role="status" aria-live="polite">
            {t(sponsored && phase.step === "donating" ? "step.single" : `step.${phase.step}`)}
          </p>
        )}
        {phase.kind === "busy" && phase.tx && txLink(phase.tx, t("pendingProof"))}
        {errorCode && (
          <div className="ch-notice" role="alert">
            <p className="m-0 break-words">{t(`errors.${errorCode}`, { network: props.networkName, address: donorAddress })}</p>
            {errorCode === "insufficient_usdc_testnet" && (
              <a className="ch-proof" href={CIRCLE_FAUCET} target="_blank" rel="noopener noreferrer">
                {t("faucet")}<span aria-hidden="true"> ↗</span>
              </a>
            )}
          </div>
        )}
        {phase.kind === "error" && phase.tx && txLink(phase.tx, t("pendingProof"))}
      </form>
      {errorCode === "insufficient_usdc_smart" && donorAddress && (
        <AddMoney
          address={donorAddress}
          mode={props.funding}
          networkName={props.networkName}
          suggestedEur={check.ok ? suggestTopUpEur(check.usdc, rate) : undefined}
        />
      )}
      <YourDonation {...props} refreshKey={refreshKey} />
    </div>
  );
}

interface MyDonationRow {
  address: string;
  donated: string;
  preference: "REFUND" | "EMERGENCY_POOL";
  subPoolId: number;
}

function YourDonation(props: DonatePanelProps & { wallet: WalletState; refreshKey: number }) {
  const t = useTranslations("campaignPage.yourDonation");
  const tDonate = useTranslations("campaignPage.donate");
  const [rows, setRows] = React.useState<MyDonationRow[] | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [pref, setPref] = React.useState<"REFUND" | "EMERGENCY_POOL">("REFUND");
  const [theme, setTheme] = React.useState("0");
  const [status, setStatus] = React.useState<"idle" | "saving" | "saved" | { error: DonateFailure }>("idle");
  const ready = props.wallet.kind === "ready";

  React.useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    fetch(`/api/donations/${props.campaign}`, { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as { donations: MyDonationRow[] }).donations : null))
      .then((list) => { if (!cancelled) setRows(list); })
      .catch(() => { if (!cancelled) setRows(null); });
    return () => { cancelled = true; };
  }, [ready, props.campaign, props.refreshKey]);

  if (!ready || !rows || rows.length === 0) return null;
  const wallet = (props.wallet as Extract<WalletState, { kind: "ready" }>).wallet;
  const total = rows.reduce((sum, r) => sum + BigInt(r.donated), 0n);
  const mine = rows.find((r) => r.address === wallet.account.toLowerCase()) ?? null;
  const shown = mine ?? rows[0]!;
  const themeName = (id: number) => props.themes.find((th) => th.poolId === id)?.name ?? tDonate("themeGeneral");

  async function save() {
    setStatus("saving");
    try {
      const provider = await wallet.provider(props.chainId);
      const tx = await changePreference(provider, wallet.account, {
        chainId: props.chainId, campaign: props.campaign,
        preference: pref === "REFUND" ? { kind: "REFUND" } : { kind: "EMERGENCY_POOL", subPoolId: Number(theme) },
      }, wallet.sendCalls);
      const ok = await waitForTx(provider, tx);
      setStatus(ok ? "saved" : { error: "reverted" });
      if (ok) setEditing(false);
    } catch (e) {
      setStatus({ error: toDonateFailure(e) });
    }
  }

  return (
    <section className="ch-donate-mine" aria-labelledby="your-donation-heading">
      <h2 className="ch-label m-0" id="your-donation-heading">{t("title")}</h2>
      <p className="m-0">{t("total", { amount: formatUsdc(total, { minDecimals: 2, maxDecimals: 6 }) })}</p>
      <p className="m-0 text-sm">
        {shown.preference === "REFUND" ? t("prefRefund") : t("prefPool", { theme: themeName(shown.subPoolId) })}
      </p>
      {!mine && <p className="m-0 text-sm">{t("otherWallet", { address: shown.address })}</p>}
      {mine && !editing && (
        <Button variant="ghost" onClick={() => { setPref(mine.preference); setTheme(String(mine.subPoolId)); setEditing(true); setStatus("idle"); }}>
          {t("change")}
        </Button>
      )}
      {mine && editing && (
        <fieldset className="ch-field ch-checkbox-group" disabled={status === "saving"}>
          <legend className="ch-label">{tDonate("ifFails")}</legend>
          <div className="ch-donate-prefs">
            {(["REFUND", "EMERGENCY_POOL"] as const).map((value) => (
              <label key={value} className="ch-checkbox">
                <input type="radio" name="mine-pref" value={value} checked={pref === value} onChange={() => setPref(value)} />
                {tDonate(value === "REFUND" ? "prefRefund" : "prefPool")}
              </label>
            ))}
          </div>
          {pref === "EMERGENCY_POOL" && props.themes.length > 0 && (
            <LabeledSelect
              label={tDonate("theme")}
              placeholder={tDonate("themeGeneral")}
              value={theme}
              onChange={setTheme}
              options={[{ value: "0", label: tDonate("themeGeneral") }, ...props.themes.map((th) => ({ value: String(th.poolId), label: th.name }))]}
            />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void save()}>{t("save")}</Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>{t("cancel")}</Button>
          </div>
        </fieldset>
      )}
      {status === "saving" && <p className="m-0 text-sm font-bold" role="status">{t("saving")}</p>}
      {status === "saved" && <p className="m-0 text-sm font-bold" role="status">{t("saved")}</p>}
      {typeof status === "object" && (
        <p className="ch-notice m-0" role="alert">{tDonate(`errors.${status.error}`, { network: props.networkName })}</p>
      )}
    </section>
  );
}

/**
 * Who brought this donor here (TASK-055, ADR-057 §5): the server reads the
 * first-touch share cookie and records it for this campaign. Fire and forget —
 * the donation never waits for it or fails because of it.
 */
function rememberReferral(campaign: string) {
  void fetch("/api/referrals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ campaign }),
    keepalive: true,
  }).catch(() => undefined);
}
