"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@cherrio/ui";
import { generateCovers } from "./covers";

/** Generates covers (fal.ai, ADR-052 §4) for the given demo campaigns, one after another. */
export function CoverGenerator({ ids, auto = false }: { ids: string[]; auto?: boolean }) {
  const t = useTranslations("admin.demo.covers");
  const router = useRouter();
  const [state, setState] = React.useState<{ running: boolean; done: number; failed: number; message: string | null }>({
    running: false, done: 0, failed: 0, message: null,
  });
  const started = React.useRef(false);

  const run = React.useCallback(async () => {
    if (ids.length === 0) return;
    setState({ running: true, done: 0, failed: 0, message: null });
    const result = await generateCovers(ids, (done, failed) => setState((s) => ({ ...s, done, failed })));
    setState({
      running: false,
      done: result.done,
      failed: result.failed,
      message: result.notConfigured
        ? t("notConfigured")
        : result.failed > 0
          ? t("finishedWithFailures", { done: result.done, failed: result.failed })
          : t("finished", { count: result.done }),
    });
    router.refresh();
  }, [ids, router, t]);

  React.useEffect(() => {
    if (auto && !started.current) {
      started.current = true;
      void run();
    }
  }, [auto, run]);

  if (ids.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {!auto && (
        <div>
          <Button disabled={state.running} onClick={() => void run()}>
            {t("button", { count: ids.length })}
          </Button>
        </div>
      )}
      {state.running && (
        <p role="status" className="text-sm text-[var(--ink)]">
          {t("progress", { current: Math.min(state.done + state.failed + 1, ids.length), total: ids.length })}
        </p>
      )}
      {state.message && (
        <p role="status" className="text-sm text-[var(--ink)]">
          {state.message}
        </p>
      )}
    </div>
  );
}
