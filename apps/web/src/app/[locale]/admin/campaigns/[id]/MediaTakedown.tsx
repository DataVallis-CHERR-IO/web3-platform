"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import {
  Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@cherrio/ui";
import { useRouter } from "@/i18n/routing";

/** Remove one media item as a platform admin (takedown of unlawful or personal content, ADR-039). Audited. */
export function MediaTakedown({ campaignId, mediaId, label }: { campaignId: string; mediaId: string; label: string }) {
  const t = useTranslations("admin.campaigns.media");
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  async function takedown() {
    setWorking(true);
    setFailed(false);
    const res = await fetch(`/api/admin/campaigns/${campaignId}/media/${mediaId}`, { method: "DELETE" }).catch(() => null);
    setWorking(false);
    if (res?.ok) {
      setOpen(false);
      router.refresh();
    } else setFailed(true);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); setFailed(false); }}>
      <DialogTrigger asChild>
        <Button variant="ghost" aria-label={`${t("remove")}: ${label}`}>
          {t("remove")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("confirmTitle")}</DialogTitle>
          <DialogDescription>{t("confirmText")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm font-bold break-all text-[var(--ink)]">{label}</p>
        {failed && (
          <p role="alert" className="p-3 border-2 border-[var(--ink)] bg-[var(--surface)] text-sm font-bold text-[var(--ink)]">
            {t("failed")}
          </p>
        )}
        <DialogFooter className="gap-2 pt-2">
          <DialogClose asChild>
            <Button variant="ghost">{t("cancel")}</Button>
          </DialogClose>
          <Button variant="primary" disabled={working} onClick={() => void takedown()}>
            {working ? t("working") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
