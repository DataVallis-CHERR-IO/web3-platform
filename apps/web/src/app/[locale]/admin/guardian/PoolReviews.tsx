"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import type { Address, Hash } from "viem";
import { Button, Textarea } from "@cherrio/ui";
import { useRouter } from "@/i18n/routing";
import { AdminWalletGate, type AdminWallets } from "@/components/admin/AdminWallets";
import { useRoleWallet } from "@/components/admin/useRoleWallet";
import { waitForConsoleTx, type ConsoleChain } from "@/lib/contracts/console-client";
import { sendResolveAllocation, toResolveFailure } from "@/lib/pool/allocation-client";

// Admin → Chain actions → "Emergency Pool allocations to decide" (TASK-014c-3).
// Per NEEDS_REVIEW allocation: the Guardian writes a note (audit_log first), then
// signs resolveAllocation(id, approve) in their own wallet after a simulation;
// the transaction is linked to the note. The page refreshes; the indexer moves
// the allocation to "Sent by CHERR.IO" / "Returned by CHERR.IO" on the public page.

export interface PoolReviewItem {
  id: string;
  /** Server-rendered summary pieces (texts already formatted). */
  heading: string;
  why: string;
  reason: string | null;
}

export interface PoolReviewsProps {
  appEnv: string;
  chainId: number;
  pool: Address;
  roles: ConsoleChain | null;
  explorerUrl: string | null;
  items: PoolReviewItem[];
}

const NOTE_MIN = 10;

export function PoolReviews(props: PoolReviewsProps) {
  const t = useTranslations("admin.guardian.panel");
  return (
    <AdminWalletGate appEnv={props.appEnv} loading={<p role="status" className="text-[var(--ink)]">{t("loading")}</p>}>
      {(w) => <ReviewsUi {...props} {...w} />}
    </AdminWalletGate>
  );
}

function ReviewsUi(props: PoolReviewsProps & AdminWallets) {
  const t = useTranslations("admin.guardian.poolReview");
  const tPanel = useTranslations("admin.guardian.panel");
  const tErr = useTranslations("campaignPage.lifecycle.errors");
  const router = useRouter();
  const { reader, holder, wallet, rolesFailed } = useRoleWallet(props, "guardian");
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<null | { id: string; step: "wallet" | "chain" }>(null);
  const [messages, setMessages] = React.useState<Record<string, { kind: "error" | "ok"; text: string; tx?: Hash }>>({});

  const setMessage = (id: string, m: { kind: "error" | "ok"; text: string; tx?: Hash } | null) =>
    setMessages((all) => {
      const next = { ...all };
      if (m) next[id] = m;
      else delete next[id];
      return next;
    });

  const decide = async (id: string, approve: boolean) => {
    const note = (notes[id] ?? "").trim();
    if (!wallet || !reader || note.length < NOTE_MIN) return;
    setMessage(id, null);
    setBusy({ id, step: "wallet" });
    try {
      const intent = await fetch(`/api/admin/emergency-pool/allocations/${id}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve, note }),
      });
      const intentBody = (await intent.json().catch(() => ({}))) as { requestId?: string; error?: string };
      if (!intent.ok || !intentBody.requestId) {
        setMessage(id, { kind: "error", text: intentBody.error === "wrong_state" ? t("wrongState") : t("saveFailed") });
        return;
      }
      let hash: Hash;
      try {
        hash = await sendResolveAllocation(
          await wallet.provider(props.chainId), wallet.account,
          { chainId: props.chainId, pool: props.pool, allocationId: BigInt(id), approve },
          { reader }
        );
      } catch (e) {
        console.error("[pool] resolve", e);
        setMessage(id, { kind: "error", text: tErr(toResolveFailure(e)) });
        return;
      }
      await fetch(`/api/admin/emergency-pool/allocations/${id}/resolve/sent`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: intentBody.requestId, txHash: hash }),
      }).then((r) => r.text()).catch((e: unknown) => console.error("[pool] resolve sent", e));
      setBusy({ id, step: "chain" });
      const outcome = await waitForConsoleTx(reader, hash);
      setMessage(
        id,
        outcome === "success" ? { kind: "ok", text: approve ? t("sentApprove") : t("sentReject"), tx: hash }
          : outcome === "reverted" ? { kind: "error", text: tPanel("reverted"), tx: hash }
          : { kind: "ok", text: tPanel("unknown"), tx: hash }
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

  return (
    <div className="flex flex-col gap-4">
      {!props.walletsReady ? null : props.wallets.length === 0 ? (
        <p className="text-sm font-bold text-[var(--ink)]">{t("noWallet")}</p>
      ) : rolesFailed ? (
        <p role="alert" className="text-sm font-bold text-[var(--ink)]">{tPanel("readFailed")}</p>
      ) : holder === null ? (
        <p className="text-sm font-bold text-[var(--ink)]">{tPanel("needsGuardian")}</p>
      ) : null}
      <ul className="m-0 p-0 list-none flex flex-col gap-4">
        {props.items.map((item) => {
          const note = notes[item.id] ?? "";
          const short = note.trim().length > 0 && note.trim().length < NOTE_MIN;
          const disabled = busy !== null || !wallet || !reader || note.trim().length < NOTE_MIN;
          const message = messages[item.id];
          return (
            <li key={item.id} className="ch-panel p-5 flex flex-col gap-3 min-w-0" aria-labelledby={`pool-review-${item.id}`}>
              <h3 id={`pool-review-${item.id}`} className="m-0 text-base font-bold text-[var(--ink)] break-words">{item.heading}</h3>
              <p className="m-0 text-sm text-[var(--ink)]">{item.why}</p>
              {item.reason !== null ? (
                <div className="flex flex-col gap-1">
                  <p className="m-0 text-sm font-bold text-[var(--ink)]">{t("reason")}</p>
                  <p className="m-0 text-sm text-[var(--ink)] whitespace-pre-line break-words">{item.reason}</p>
                </div>
              ) : (
                <p className="m-0 text-sm text-[var(--ink-muted)]">{t("reasonMissing")}</p>
              )}
              <p className="m-0 text-sm text-[var(--ink)]">{t("choices")}</p>
              <Textarea
                id={`pool-review-note-${item.id}`}
                label={tPanel("noteRequired")}
                hint={t("noteHint")}
                error={short ? tPanel("noteTooShort") : undefined}
                rows={3}
                maxLength={2000}
                value={note}
                onChange={(e) => setNotes({ ...notes, [item.id]: e.target.value })}
              />
              <div className="flex flex-wrap gap-3">
                <Button disabled={disabled} onClick={() => void decide(item.id, true)}>{t("approve")}</Button>
                <Button variant="ghost" disabled={disabled} onClick={() => void decide(item.id, false)}>{t("reject")}</Button>
              </div>
              {busy?.id === item.id && (
                <p role="status" className="m-0 text-sm font-bold text-[var(--ink)]">{busy.step === "wallet" ? tPanel("working") : tPanel("confirming")}</p>
              )}
              {message && (
                <div role={message.kind === "error" ? "alert" : "status"} className="text-sm font-bold text-[var(--ink)] flex flex-col gap-1">
                  <span>{message.text}</span>
                  {message.tx && <span>{tPanel("transaction")}: {txLink(message.tx)}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
