"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { Button } from "@cherrio/ui";
import { Link } from "@/i18n/routing";

export function UnsubscribeButton({ token }: { token: string }) {
  const t = useTranslations("notifications");
  const [state, setState] = React.useState<"idle" | "busy" | "done" | "unknown" | "failed">("idle");
  const stop = async () => {
    setState("busy");
    try {
      const res = await fetch(`/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`, { method: "POST" });
      setState(res.ok ? "done" : res.status === 404 ? "unknown" : "failed");
    } catch {
      setState("failed");
    }
  };
  if (state === "done") return <p role="status" className="ch-notice m-0 font-bold">{t("unsubscribeDone")}</p>;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button onClick={() => void stop()} disabled={state === "busy" || !token}>{t("unsubscribeButton")}</Button>
      </div>
      {(state === "unknown" || !token) && (
        <p role="alert" className="text-base text-[var(--ink)]">
          {t("unsubscribeUnknown")} <Link href="/account/notifications">{t("toSettings")}</Link>
        </p>
      )}
      {state === "failed" && <p role="alert" className="text-base text-[var(--ink)]">{t("errors.failed")}</p>}
    </div>
  );
}
