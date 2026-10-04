"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { createPublicClient, custom, http, type Address, type Hash, type PublicClient } from "viem";
import { Button, Textarea } from "@cherrio/ui";
import { useRouter } from "@/i18n/routing";
import { AdminWalletGate, type AdminWallets } from "@/components/admin/AdminWallets";
import { readRoles, waitForConsoleTx, type ConsoleChain, type WalletRoles } from "@/lib/contracts/console-client";
import { sendLifecycle, toLifecycleFailure, type LifecycleAction } from "@/lib/campaigns/lifecycle-client";
import type { ChainAction, PayoutSuggestion } from "@/lib/admin/guardian";

// Admin campaign page → "On the blockchain — CHERR.IO actions" (TASK-033d):
// the operator sets the payout mode, the Guardian decides a review, unfreezes,
// rejects or freezes. Each action: the note is recorded first (audit_log), then
// the admin's own wallet signs (simulated through /api/rpc), then the hash is
// linked to the note. The page refreshes; the indexer updates the state.

interface Props {
  campaignId: string;
  campaign: Address;
  chain: { chainId: number; roles: ConsoleChain | null };
  explorerUrl: string | null;
  appEnv: string;
  state: string;
  open: Record<ChainAction, boolean>;
  individual: boolean;
  suggestion: PayoutSuggestion | null;
}

const NOTE_MIN = 10;
type Role = "operator" | "guardian";

export function GuardianPanel(props: Props) {
  const t = useTranslations("admin.guardian.panel");
  if (!props.open.setPayoutMode && !props.open.resolve && !props.open.freeze) {
    return <p className="text-base text-[var(--ink)]">{t("nothing")}</p>;
  }
  return (
    <AdminWalletGate appEnv={props.appEnv} loading={<p role="status" className="text-[var(--ink)]">{t("loading")}</p>}>
      {(w) => <PanelUi {...props} {...w} />}
    </AdminWalletGate>
  );
}

function PanelUi(props: Props & AdminWallets) {
  const t = useTranslations("admin.guardian.panel");
  const tErr = useTranslations("campaignPage.lifecycle.errors");
  const tAdminErr = useTranslations("admin.campaigns.errors");
  const router = useRouter();
  const { chainId, roles: roleChain } = props.chain;
  const [reader, setReader] = React.useState<PublicClient | null>(null);
  const [roles, setRoles] = React.useState<{ account: Address; roles: Pick<WalletRoles, Role> }[] | null>(null);
  const [rolesFailed, setRolesFailed] = React.useState(false);
  const [mode, setMode] = React.useState<0 | 1>(props.individual ? 1 : (props.suggestion?.mode ?? 1));
  const [notes, setNotes] = React.useState<Record<"payout" | "review" | "freeze", string>>({ payout: "", review: "", freeze: "" });
  const [freezeConfirmed, setFreezeConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState<null | "wallet" | "chain">(null);
  const [message, setMessage] = React.useState<{ kind: "error" | "ok"; text: string; tx?: Hash } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const transport = props.readProvider ? custom(await props.readProvider(chainId)) : http(`${window.location.origin}/api/rpc`, { retryCount: 0 });
      if (!cancelled) setReader(createPublicClient({ transport }));
    })();
    return () => { cancelled = true; };
  }, [props.readProvider, chainId]);

  React.useEffect(() => {
    if (!reader || props.wallets.length === 0) return;
    // Without the PlatformConfig address (unconfigured local env) the roles cannot be read: let the contract judge.
    if (!roleChain) {
      setRoles(props.wallets.map((w) => ({ account: w.account, roles: { operator: true, guardian: true } })));
      return;
    }
    void Promise.all(props.wallets.map(async (w) => ({ account: w.account, roles: await readRoles(reader, roleChain, w.account) })))
      .then((list) => { setRoles(list); setRolesFailed(false); })
      .catch((e: unknown) => { console.error("[guardian] roles", e); setRolesFailed(true); });
  }, [reader, props.wallets, roleChain]);

  const walletWith = (role: Role) => {
    const found = roles?.find((r) => r.roles[role]);
    return found ? props.wallets.find((w) => w.account === found.account) ?? null : null;
  };

  const run = async (role: Role, action: LifecycleAction, note: string, body: Record<string, unknown>) => {
    const wallet = walletWith(role);
    if (!wallet || !reader) return;
    setMessage(null);
    setBusy("wallet");
    try {
      const intent = await fetch(`/api/admin/campaigns/${props.campaignId}/chain-actions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, note }),
      });
      const intentBody = (await intent.json().catch(() => ({}))) as { requestId?: string; error?: string };
      if (!intent.ok || !intentBody.requestId) {
        const code = intentBody.error;
        setMessage({ kind: "error", text: code && tAdminErr.has(code as never) ? tAdminErr(code as never) : tErr("failed") });
        return;
      }
      let hash: Hash;
      try {
        hash = await sendLifecycle(await wallet.provider(chainId), wallet.account, { chainId, campaign: props.campaign, action }, { reader });
      } catch (e) {
        console.error("[guardian] send", e);
        setMessage({ kind: "error", text: tErr(toLifecycleFailure(e)) });
        return;
      }
      await fetch(`/api/admin/campaigns/${props.campaignId}/chain-actions/sent`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: intentBody.requestId, txHash: hash }),
      }).catch((e: unknown) => console.error("[guardian] sent", e));
      setBusy("chain");
      const outcome = await waitForConsoleTx(reader, hash);
      setMessage(
        outcome === "success" ? { kind: "ok", text: t("sent"), tx: hash }
          : outcome === "reverted" ? { kind: "error", text: t("reverted"), tx: hash }
          : { kind: "ok", text: t("unknown"), tx: hash }
      );
      if (outcome === "success") router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const txLink = (tx: Hash) =>
    props.explorerUrl ? (
      <a href={`${props.explorerUrl}/tx/${tx}`} target="_blank" rel="noreferrer" className="ch-mono underline break-all">{tx}</a>
    ) : <span className="ch-mono break-all">{tx}</span>;

  const noteField = (key: keyof typeof notes, required: boolean) => {
    const value = notes[key];
    const short = required && value.trim().length > 0 && value.trim().length < NOTE_MIN;
    return (
      <Textarea
        id={`guardian-note-${key}`}
        label={required ? t("noteRequired") : t("note")}
        hint={t("noteHint")}
        error={short ? t("noteTooShort") : undefined}
        rows={3}
        maxLength={2000}
        value={value}
        onChange={(e) => setNotes({ ...notes, [key]: e.target.value })}
      />
    );
  };
  const noteOk = (key: keyof typeof notes) => notes[key].trim().length >= NOTE_MIN;

  const operator = walletWith("operator");
  const guardian = walletWith("guardian");
  const disabled = busy !== null || !reader;
  const { open } = props;

  return (
    <div className="flex flex-col gap-6">
      {!props.walletsReady ? null : props.wallets.length === 0 ? (
        <p className="text-sm font-bold text-[var(--ink)]">{t("noWallet")}</p>
      ) : rolesFailed ? (
        <p role="alert" className="text-sm font-bold text-[var(--ink)]">{t("readFailed")}</p>
      ) : roles && roleChain ? (
        <ul className="flex flex-col gap-1 text-sm text-[var(--ink)]" aria-label={t("wallets")}>
          {roles.map((r) => {
            const held = (["operator", "guardian"] as const).filter((k) => r.roles[k]);
            return (
              <li key={r.account}>
                <span className="ch-mono break-all">{r.account}</span>:{" "}
                {held.length ? held.map((k) => t(k === "operator" ? "roleOperator" : "roleGuardian")).join(", ") : t("roleNone")}
              </li>
            );
          })}
        </ul>
      ) : null}

      {open.setPayoutMode && (
        <section className="ch-panel p-5 flex flex-col gap-3" aria-labelledby="guardian-payout">
          <h3 id="guardian-payout" className="text-lg font-display uppercase text-[var(--ink)]">{t("payoutTitle")}</h3>
          <p className="text-sm text-[var(--ink)]">{t("payoutText")}</p>
          {props.suggestion && (
            <p className="text-sm font-bold text-[var(--ink)]">
              {t("suggestion", { mode: props.suggestion.mode === 0 ? t("single") : t("milestones") })} —{" "}
              {t(`reasons.${props.suggestion.reason}`, { rating: props.suggestion.rating?.toFixed(1) ?? "" })}
            </p>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="ch-sr-only">{t("payoutTitle")}</legend>
            {([1, 0] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 text-base text-[var(--ink)]">
                <input type="radio" name="payout-mode" value={m} checked={mode === m} disabled={m === 0 && props.individual} onChange={() => setMode(m)} />
                {m === 0 ? t("single") : t("milestones")}
                {m === 0 && props.individual && <span className="text-xs text-[var(--ink-muted)]">({t("singleNotAllowed")})</span>}
              </label>
            ))}
          </fieldset>
          {noteField("payout", false)}
          {roles && !operator && <p className="text-sm font-bold text-[var(--ink)]">{t("needsOperator")}</p>}
          <div>
            <Button
              disabled={disabled || !operator || (notes.payout.trim().length > 0 && !noteOk("payout"))}
              onClick={() => void run("operator", { kind: "setPayoutMode", mode }, notes.payout.trim(), { action: "setPayoutMode", mode })}
            >
              {t("setPayoutMode")}
            </Button>
          </div>
        </section>
      )}

      {open.resolve && (
        <section className="ch-panel p-5 flex flex-col gap-3" aria-labelledby="guardian-review">
          <h3 id="guardian-review" className="text-lg font-display uppercase text-[var(--ink)]">
            {props.state === "FROZEN" ? t("frozenTitle") : t("reviewTitle")}
          </h3>
          <p className="text-sm text-[var(--ink)]">{props.state === "FROZEN" ? t("frozenText") : t("reviewText")}</p>
          {noteField("review", true)}
          {roles && !guardian && <p className="text-sm font-bold text-[var(--ink)]">{t("needsGuardian")}</p>}
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={disabled || !guardian || !noteOk("review")}
              onClick={() => void run("guardian", { kind: "resolve", approve: true }, notes.review.trim(), { action: "resolve", approve: true })}
            >
              {props.state === "FROZEN" ? t("unfreeze") : t("approve")}
            </Button>
            <Button
              variant="ghost"
              disabled={disabled || !guardian || !noteOk("review")}
              onClick={() => void run("guardian", { kind: "resolve", approve: false }, notes.review.trim(), { action: "resolve", approve: false })}
            >
              {t("reject")}
            </Button>
          </div>
        </section>
      )}

      {open.freeze && (
        <section className="ch-panel p-5 flex flex-col gap-3" aria-labelledby="guardian-freeze">
          <h3 id="guardian-freeze" className="text-lg font-display uppercase text-[var(--ink)]">{t("freezeTitle")}</h3>
          <p className="text-sm text-[var(--ink)]">{t("freezeText")}</p>
          {noteField("freeze", true)}
          <label className="flex items-center gap-2 text-sm text-[var(--ink)]">
            <input type="checkbox" checked={freezeConfirmed} onChange={(e) => setFreezeConfirmed(e.target.checked)} />
            {t("freezeConfirm")}
          </label>
          {roles && !guardian && <p className="text-sm font-bold text-[var(--ink)]">{t("needsGuardian")}</p>}
          <div>
            <Button
              variant="ghost"
              disabled={disabled || !guardian || !noteOk("freeze") || !freezeConfirmed}
              onClick={() => void run("guardian", { kind: "freeze" }, notes.freeze.trim(), { action: "freeze" })}
            >
              {t("freeze")}
            </Button>
          </div>
        </section>
      )}

      {busy && <p role="status" className="text-sm font-bold text-[var(--ink)]">{busy === "wallet" ? t("working") : t("confirming")}</p>}
      {message && (
        <div role={message.kind === "error" ? "alert" : "status"} className="ch-panel p-4 text-sm font-bold text-[var(--ink)] flex flex-col gap-1">
          <span>{message.text}</span>
          {message.tx && <span>{t("transaction")}: {txLink(message.tx)}</span>}
        </div>
      )}
    </div>
  );
}
