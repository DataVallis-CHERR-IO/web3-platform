"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { createPublicClient, custom, http, type Address, type Hash } from "viem";
import { Button, FileField, ProofLink, Textarea } from "@cherrio/ui";
import { useRouter } from "@/i18n/routing";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";
import { sendLifecycle, toLifecycleFailure } from "@/lib/campaigns/lifecycle-client";
import { shortAddress } from "@/lib/campaigns/lifecycle-view";
import type { EvidenceBundleView, listOwnEvidence } from "@/lib/campaigns/evidence";
import {
  signerFor, useE2eSigner, usePrivySigners, type SignerState,
} from "@/components/campaigns/lifecycle-signers";

// Milestone evidence on the fundraiser's dashboard (TASK-033c part 2, ADR-047):
// files (private or public) and a public note for the open round → seal (the
// server builds the manifest and its SHA-256) → `submitEvidence(bundleHash)`
// from the campaign's payout wallet, simulated through `/api/rpc` first. Then
// the submitted rounds with their fingerprint.

export type EvidenceData = Awaited<ReturnType<typeof listOwnEvidence>>;

export interface EvidenceManagerProps {
  campaignId: string;
  campaign: Address;
  beneficiary: Address;
  chainId: number;
  appEnv: string;
  explorerTx: string | null;
  initial: EvidenceData;
}

const MAX_FILES = 10;

export function EvidenceManager(props: EvidenceManagerProps) {
  const { isAvailable } = useAppAuth();
  const e2e = useE2eSigner(props.appEnv);
  if (isAvailable) return <PrivyEvidence {...props} />;
  return <EvidenceUi {...props} signers={e2e ? { kind: "ready", signers: [e2e] } : { kind: "unavailable" }} useE2eReader={e2e !== null} />;
}

function PrivyEvidence(props: EvidenceManagerProps) {
  const signers = usePrivySigners(props.chainId);
  return <EvidenceUi {...props} signers={signers} useE2eReader={false} />;
}

type Message = { kind: "ok" | "error"; text: string; tx?: Hash } | null;

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const typeText = (mime: string) => (mime === "application/pdf" ? "PDF" : mime.replace("image/", "").toUpperCase());

function EvidenceUi(props: EvidenceManagerProps & { signers: SignerState; useE2eReader: boolean }) {
  const t = useTranslations("campaigns.evidence");
  const tErrors = useTranslations("campaigns.errors");
  const tChain = useTranslations("campaignPage.lifecycle.errors");
  const router = useRouter();
  const [data, setData] = React.useState<EvidenceData>(props.initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<Message>(null);
  const [visibility, setVisibility] = React.useState<"private" | "public">("private");
  const [picker, setPicker] = React.useState(0);
  const draft = data.bundles.find((b) => b.round === data.openRound) ?? null;
  const [note, setNote] = React.useState(draft?.note ?? "");
  const base = `/api/campaigns/${props.campaignId}/evidence`;

  const reload = React.useCallback(async () => {
    const res = await fetch(base, { cache: "no-store" });
    if (res.ok) setData((await res.json()) as EvidenceData);
  }, [base]);

  const errorText = (code?: string) => (code && tErrors.has(code as never) ? tErrors(code as never) : t("failed"));

  /** One API call; returns the JSON on success, else shows the error and returns null. */
  async function api<T>(key: string, request: () => Promise<Response>): Promise<T | null> {
    setBusy(key);
    setMessage(null);
    try {
      const res = await request();
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage({ kind: "error", text: errorText(json.error) });
        return null;
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      setMessage({ kind: "error", text: t("failed") });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    const body = new FormData();
    body.set("file", file);
    await api("upload", () => fetch(`${base}/files?visibility=${visibility}`, { method: "POST", body }));
    setPicker((n) => n + 1);
    await reload();
  }

  async function submit(bundleHash: `0x${string}`) {
    if (props.signers.kind !== "ready") return;
    const signer = signerFor(props.signers.signers, props.beneficiary);
    if (!signer) return;
    setBusy("submit");
    setMessage(null);
    let tx: Hash | undefined;
    try {
      const provider = await signer.provider(props.chainId);
      const read = props.useE2eReader || typeof window === "undefined"
        ? createPublicClient({ transport: custom(provider, { retryCount: 0 }) })
        : createPublicClient({ transport: http(`${window.location.origin}/api/rpc`, { retryCount: 0 }) });
      tx = await sendLifecycle(provider, signer.account, {
        chainId: props.chainId, campaign: props.campaign, action: { kind: "submitEvidence", bundleHash },
      }, { reader: read, sendCalls: signer.sendCalls });
      setMessage({ kind: "ok", text: t("sent"), tx });
      const receipt = await read.waitForTransactionReceipt({ hash: tx, timeout: 180_000, pollingInterval: 3_000 }).catch(() => null);
      if (receipt && receipt.status !== "success") {
        setMessage({ kind: "error", text: tChain("reverted"), tx });
        return;
      }
      setMessage({ kind: "ok", text: t("confirmed"), tx });
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        const res = await fetch(base, { cache: "no-store" });
        if (!res.ok) continue;
        const next = (await res.json()) as EvidenceData;
        setData(next);
        if (next.bundles.some((b) => b.bundleHash === bundleHash && b.onChain)) break;
      }
      router.refresh();
    } catch (e) {
      console.error("[evidence] submit", e);
      const code = toLifecycleFailure(e);
      setMessage({ kind: "error", text: tChain.has(code as never) ? tChain(code as never) : tChain("failed"), tx });
    } finally {
      setBusy(null);
    }
  }

  async function sealAndSubmit() {
    const sealed = await api<{ bundleHash: `0x${string}` }>("seal", () => fetch(`${base}/seal`, { method: "POST" }));
    await reload();
    if (sealed) await submit(sealed.bundleHash);
  }

  const beneficiarySigner = props.signers.kind === "ready" ? signerFor(props.signers.signers, props.beneficiary) : null;
  const walletNote =
    props.signers.kind === "logged_out" ? t("loginToSubmit")
    : !beneficiarySigner ? t("connectBeneficiary", { address: shortAddress(props.beneficiary) })
    : null;
  const history = data.bundles.filter((b) => b.round !== data.openRound || b.onChain);
  if (data.openRound === null && history.length === 0) return null;
  const disabled = busy !== null;
  const heading = "text-lg font-display uppercase text-[var(--ink)]";

  const fileList = (bundle: EvidenceBundleView, editable: boolean) =>
    bundle.files.length === 0 ? (
      <p className="m-0 text-sm">{t("noFiles")}</p>
    ) : (
      <ol className="m-0 flex flex-col gap-2 p-0 list-none">
        {bundle.files.map((f, i) => (
          <li key={f.id} className="flex flex-wrap items-center gap-3 text-sm text-[var(--ink)]">
            <span className="font-bold">{t(f.visibility === "PRIVATE" ? "privateFile" : "publicFile")}</span>
            <span>{t("fileRow", { type: typeText(f.mimeType), size: sizeText(f.sizeBytes) })}</span>
            <span className="ch-mono break-all">{f.sha256.slice(0, 16)}…</span>
            {f.url ? (
              <ProofLink href={f.url} external>{t("open")}</ProofLink>
            ) : (
              <a className="underline" href={`${base}/files/${f.id}`}>{t("download")}</a>
            )}
            {editable && (
              <Button variant="ghost" disabled={disabled} aria-label={t("removeLabel", { n: i + 1 })}
                onClick={async () => {
                  await api("remove", () => fetch(`${base}/files/${f.id}`, { method: "DELETE" }));
                  await reload();
                }}>
                {t("remove")}
              </Button>
            )}
          </li>
        ))}
      </ol>
    );

  return (
    <section id="evidence" className="ch-panel p-6 md:p-8 flex flex-col gap-6" aria-labelledby="evidence-title" aria-live="polite">
      <div className="flex flex-col gap-2">
        <h2 id="evidence-title" className="text-xl font-display uppercase text-[var(--ink)]">{t("title")}</h2>
        <p className="m-0 text-sm text-[var(--ink)]">{t("intro")}</p>
      </div>

      {data.openRound !== null && (
        <div className="flex flex-col gap-4">
          <h3 className={heading}>{t("openTitle", { payment: data.openRound + 2 })}</h3>

          {draft?.bundleHash ? (
            <div className="flex flex-col gap-3">
              <p className="m-0 text-sm">{t("sealed")} <span className="ch-mono break-all">{draft.bundleHash}</span></p>
              {fileList(draft, false)}
              {draft.note && <p className="m-0 text-sm whitespace-pre-line">{draft.note}</p>}
              {beneficiarySigner && (
                <Button variant="primary" disabled={disabled} onClick={() => void submit(draft.bundleHash as `0x${string}`)}>
                  {busy === "submit" ? t("working") : t("submit")}
                </Button>
              )}
              {walletNote && <p className="m-0 text-sm font-bold">{walletNote}</p>}
              <Button variant="ghost" disabled={disabled}
                onClick={async () => {
                  await api("reopen", () => fetch(`${base}/seal`, { method: "DELETE" }));
                  await reload();
                }}>
                {t("reopen")}
              </Button>
              <p className="m-0 text-sm">{t("reopenHint")}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <form className="flex flex-col gap-3" onSubmit={async (event) => {
                event.preventDefault();
                const ok = await api("note", () =>
                  fetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }) }));
                if (ok) setMessage({ kind: "ok", text: t("noteSaved") });
                await reload();
              }}>
                <Textarea label={t("note")} hint={t("noteHint")} value={note} maxLength={2000} rows={4}
                  onChange={(e) => setNote(e.target.value)} />
                <Button type="submit" variant="secondary" disabled={disabled}>{busy === "note" ? t("working") : t("saveNote")}</Button>
              </form>

              <h4 className="ch-label m-0">{t("files", { count: draft?.files.length ?? 0, max: MAX_FILES })}</h4>
              {draft && fileList(draft, true)}
              {(draft?.files.length ?? 0) < MAX_FILES && (
                <div className="flex flex-col gap-3">
                  <fieldset className="ch-field ch-checkbox-group" disabled={disabled}>
                    <legend className="ch-label">{t("visibility")}</legend>
                    {(["private", "public"] as const).map((v) => (
                      <label key={v} className="ch-checkbox">
                        <input type="radio" name="evidence-visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} />
                        {t(v)}
                      </label>
                    ))}
                  </fieldset>
                  <FileField
                    key={`evidence-${picker}`}
                    label={t("addFile")}
                    hint={t("fileHint")}
                    accept=".pdf,.jpg,.jpeg,.png"
                    busy={busy === "upload"}
                    fileLabel={busy === "upload" ? t("uploading") : undefined}
                    removeLabel={t("remove")}
                    onSelect={(file) => void upload(file)}
                    onRemove={() => undefined}
                  />
                </div>
              )}

              <p className="m-0 text-sm">{t("sealHint")}</p>
              {walletNote && <p className="m-0 text-sm font-bold">{walletNote}</p>}
              <Button variant="primary" disabled={disabled || !beneficiarySigner || (draft?.files.length ?? 0) === 0}
                onClick={() => void sealAndSubmit()}>
                {busy === "seal" || busy === "submit" ? t("working") : t("seal")}
              </Button>
            </div>
          )}
        </div>
      )}

      {message && (
        <div role={message.kind === "error" ? "alert" : "status"} className="flex flex-col gap-1 text-sm">
          <span className="font-bold">{message.text}</span>
          {message.tx && (props.explorerTx
            ? <ProofLink href={`${props.explorerTx}${message.tx}`} external>{t("viewTx")}</ProofLink>
            : <span className="ch-mono break-all">{message.tx}</span>)}
        </div>
      )}

      {history.length > 0 && (
        <div className="flex flex-col gap-4">
          <h3 className={heading}>{t("history")}</h3>
          {history.map((b) => (
            <div key={b.id} className="flex flex-col gap-2">
              <p className="m-0 text-sm font-bold">
                {t("round", { payment: b.round + 2 })} · {t(b.onChain ? "onChain" : "notOnChain")}
              </p>
              {b.bundleHash && (
                <p className="m-0 text-sm">{t("fingerprint")}: <span className="ch-mono break-all">{b.bundleHash}</span></p>
              )}
              {b.note && <p className="m-0 text-sm whitespace-pre-line">{b.note}</p>}
              {fileList(b, false)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
