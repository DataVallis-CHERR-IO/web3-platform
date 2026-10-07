"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import {
  CAMPAIGN_SORTS,
  MAX_SEARCH_LENGTH,
  listQuery,
  type CampaignSort,
  type ListState,
} from "@/lib/campaigns/filter-options";

// Search and sort above the public campaign list (TASK-053). One GET form, so
// both work without JavaScript (the chosen causes and countries travel as hidden
// fields); with JavaScript the URL is replaced in place, like the filters.

export function CampaignListControls({
  state,
  locale,
}: {
  state: ListState;
  locale: string;
}) {
  const t = useTranslations("campaignPage.controls");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [q, setQ] = useState(state.q);
  useEffect(() => setQ(state.q), [state.q]);

  function go(next: Partial<ListState>) {
    startTransition(() => {
      router.replace(
        { pathname: "/campaigns", query: listQuery({ ...state, ...next }) },
        { scroll: false },
      );
    });
  }

  return (
    <form
      method="get"
      action={`/${locale}/campaigns`}
      role="search"
      className="ch-list-controls"
      aria-busy={pending || undefined}
      onSubmit={(e) => {
        if (!hydrated) return;
        e.preventDefault();
        go({ q: q.replace(/\s+/g, " ").trim() });
      }}
    >
      {state.causes.map((c) => (
        <input key={`cause-${c}`} type="hidden" name="cause" value={c} />
      ))}
      {state.countries.map((c) => (
        <input key={`country-${c}`} type="hidden" name="country" value={c} />
      ))}

      <div className="ch-list-search">
        <label htmlFor="campaign-search" className="ch-list-label">
          {t("searchLabel")}
        </label>
        <div className="ch-list-search-row">
          <input
            id="campaign-search"
            type="search"
            name="q"
            className="ch-input"
            placeholder={t("searchPlaceholder")}
            maxLength={MAX_SEARCH_LENGTH}
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit" className="ch-btn ch-list-search-btn">
            {t("searchButton")}
          </button>
        </div>
      </div>

      <div className="ch-list-sort">
        <label htmlFor="campaign-sort" className="ch-list-label">
          {t("sortLabel")}
        </label>
        <select
          id="campaign-sort"
          name="sort"
          className="ch-list-sort-select"
          value={state.sort}
          onChange={(e) => {
            if (hydrated) go({ sort: e.target.value as CampaignSort });
          }}
        >
          {CAMPAIGN_SORTS.map((s) => (
            <option key={s} value={s}>
              {t(`sort.${s}`)}
            </option>
          ))}
        </select>
      </div>
    </form>
  );
}
