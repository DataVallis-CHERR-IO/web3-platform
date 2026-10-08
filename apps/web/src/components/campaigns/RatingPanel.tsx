"use client";
import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { createWalletClient, custom, type Address, type Hex } from "viem";
import { RATING_COMMENT_MAX, ratingTypedData } from "@cherrio/shared/ratings";
import { Button } from "@cherrio/ui";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";
import { usePrivySigners, useE2eSigner, type Signer, type SignerState } from "./lifecycle-signers";

// "Rate the organisation" (ADR-058, TASK-057): a donor of a finished campaign
// rates the organisation 1–5 with an optional private comment, signed with a
// linked wallet (EIP-712). Shown only to people who may rate (or did).

export interface RatingPanelProps {
  campaignId: string;
  chainId: number;
  appEnv: string;
}

interface RatingState {
  status: "open" | "individual" | "not_finished" | "window_closed" | "not_donor" | "own";
  organization: string | null;
  campaign: Address | null;
  windowEndsAt: string | null;
  rating: { stars: number; comment: string | null; updatedAt: string } | null;
}

export function RatingPanel(props: RatingPanelProps) {
  const { isAvailable } = useAppAuth();
  const e2e = useE2eSigner(props.appEnv);
  if (isAvailable) return <PrivyRating {...props} />;
  return <RatingUi {...props} signers={e2e ? { kind: "ready", signers: [e2e] } : { kind: "unavailable" }} />;
}

function PrivyRating(props: RatingPanelProps) {
  return <RatingUi {...props} signers={usePrivySigners(props.chainId)} />;
}

async function signRating(signer: Signer, chainId: number, typedData: ReturnType<typeof ratingTypedData>): Promise<Hex> {
  if (signer.signTypedData) return signer.signTypedData(typedData);
  const wallet = createWalletClient({ account: signer.account, transport: custom(await signer.provider(chainId)) });
  return wallet.signTypedData({ ...typedData, account: signer.account });
}

function RatingUi(props: RatingPanelProps & { signers: SignerState }) {
  const t = useTranslations("campaignPage.rating");
  const locale = useLocale();
  const [data, setData] = React.useState<RatingState | null>(null);
  const [stars, setStars] = React.useState<number | null>(null);
  const [comment, setComment] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const ready = props.signers.kind === "ready";

  const load = React.useCallback(async () => {
    const res = await fetch(`/api/campaigns/${props.campaignId}/rating`, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as RatingState | null;
    if (!res.ok || !body) return;
    setData(body);
    if (body.rating) {
      setStars(body.rating.stars);
      setComment(body.rating.comment ?? "");
    }
  }, [props.campaignId]);

  React.useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  if (!data || !["open", "window_closed"].includes(data.status)) return null;
  if (data.status === "window_closed" && !data.rating) return null;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const signer = props.signers.kind === "ready" ? props.signers.signers[0] ?? null : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!data?.campaign || !data.organization || stars === null || !signer) return;
    setBusy(true);
    setMessage(null);
    try {
      const issuedAt = Math.floor(Date.now() / 1000);
      const text = comment.trim() || null;
      const typed = ratingTypedData(props.chainId, {
        campaign: data.campaign, organization: data.organization, stars, comment: text, issuedAt: BigInt(issuedAt),
      });
      const signature = await signRating(signer, props.chainId, typed);
      const res = await fetch(`/api/campaigns/${props.campaignId}/rating`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stars, comment: text, signer: signer.account, issuedAt, signature }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const key = `errors.${body.error}`;
        setMessage({ kind: "error", text: t.has(key as never) ? t(key as never) : t("errors.generic") });
        return;
      }
      setMessage({ kind: "ok", text: t("saved") });
      await load();
    } catch {
      setMessage({ kind: "error", text: t("errors.notSigned") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="rating" className="ch-panel ch-rating" aria-labelledby="rating-heading">
      <h2 id="rating-heading" className="m-0 text-xl font-display uppercase text-[var(--ink)]">{t("heading")}</h2>
      {data.status === "window_closed" ? (
        <p className="m-0">{t("closed", { stars: data.rating!.stars })}</p>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
          <p className="m-0 text-sm text-[var(--ink-muted)]">
            {t("intro", { date: data.windowEndsAt ? date.format(new Date(data.windowEndsAt)) : "" })}
          </p>
          <fieldset className="ch-field ch-checkbox-group" disabled={busy}>
            <legend className="ch-label">{t("starsLegend")}</legend>
            <div className="ch-checkbox-list">
              {[1, 2, 3, 4, 5].map((value) => (
                <label key={value} className="ch-checkbox">
                  <input type="radio" name="rating-stars" value={value} checked={stars === value} onChange={() => setStars(value)} />
                  {t("star", { count: value })}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="ch-field">
            <label className="ch-label" htmlFor="rating-comment">{t("commentLabel")}</label>
            <textarea
              id="rating-comment"
              className="ch-input ch-textarea"
              maxLength={RATING_COMMENT_MAX}
              value={comment}
              disabled={busy}
              aria-describedby="rating-comment-hint"
              onChange={(e) => setComment(e.target.value)}
            />
            <span id="rating-comment-hint" className="ch-field-hint">{t("commentHint")}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={busy || stars === null || !signer}>
              {busy ? t("signing") : data.rating ? t("update") : t("submit")}
            </Button>
            {data.rating && (
              <span className="text-sm text-[var(--ink-muted)]">
                {t("current", { stars: data.rating.stars, date: date.format(new Date(data.rating.updatedAt)) })}
              </span>
            )}
          </div>
          <p className="m-0 text-sm text-[var(--ink-muted)]">{t("signNote")}</p>
        </form>
      )}
      {message && (
        <p className={message.kind === "ok" ? "ch-notice m-0" : "ch-field-error m-0"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}
    </section>
  );
}
