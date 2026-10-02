"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import {
  Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DialogTrigger, Textarea,
} from "@cherrio/ui";

/** Approve (with the ECB snapshot, after a confirmation) or reject (with a note). */
export function CampaignReviewActions({ campaignId, payoutAddress }: { campaignId: string; payoutAddress: string }) {
  const t = useTranslations("admin.campaigns");
  const tErrors = useTranslations("admin.campaigns.errors");
  const router = useRouter();
  const [note, setNote] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function decide(action: "approve" | "reject", body: Record<string, string>) {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setOpen(false);
        setWorking(false);
        router.refresh();
        return;
      }
      const code = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "";
      setError(tErrors.has(code as never) ? tErrors(code as never) : t("failed"));
    } catch {
      setError(t("failed"));
    }
    setWorking(false);
  }

  const alert = error && (
    <p role="alert" className="p-3 border-2 border-[var(--ink)] bg-[var(--surface)] text-sm font-bold text-[var(--ink)]">
      {error}
    </p>
  );

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <Dialog open={open} onOpenChange={(next) => { setOpen(next); setError(null); }}>
          <DialogTrigger asChild>
            <Button variant="primary">{t("approve")}</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("approveTitle")}</DialogTitle>
              <DialogDescription>{t("approveText")}</DialogDescription>
            </DialogHeader>
            <p className="ch-mono text-sm font-bold break-all text-[var(--ink)]">{payoutAddress}</p>
            {open && alert}
            <DialogFooter className="gap-2 pt-2">
              <DialogClose asChild>
                <Button variant="ghost">{t("cancel")}</Button>
              </DialogClose>
              <Button variant="primary" disabled={working} onClick={() => decide("approve", {})}>
                {working ? t("working") : t("approveConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void decide("reject", { note });
        }}
      >
        <Textarea
          label={t("rejectNote")}
          hint={t("rejectNoteHint")}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={1000}
        />
        {!open && alert}
        <div>
          <Button type="submit" disabled={working || note.trim().length < 10}>
            {working ? t("working") : t("reject")}
          </Button>
        </div>
      </form>
    </div>
  );
}
