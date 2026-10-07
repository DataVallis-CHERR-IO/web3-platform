"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@cherrio/ui";
import { useRouter } from "@/i18n/routing";
import {
  COLLAPSED_LIMIT,
  DEFAULT_CAMPAIGN_SORT,
  SEARCH_FROM,
  listQuery,
  toggleValue,
  visibleOptions,
  type CampaignSort,
  type FilterOption,
} from "@/lib/campaigns/filter-options";

// Shop-style filters for the public campaign list (TASK-042): a sidebar with
// collapsible groups of checkboxes on wide screens, a "Filters" button that
// opens the same groups in a bottom sheet on tablets and phones. Every change
// updates the URL at once (the server renders the new list); without
// JavaScript the form submits with its "Apply" button.

export interface FilterGroupData {
  name: "cause" | "country";
  options: FilterOption[];
  selected: string[];
}

export function CampaignFilters({
  groups,
  total,
  locale,
  keep = { q: "", sort: DEFAULT_CAMPAIGN_SORT },
}: {
  groups: FilterGroupData[];
  total: number;
  locale: string;
  /** Search and sort (TASK-053): a filter change keeps them. */
  keep?: { q: string; sort: CampaignSort };
}) {
  const t = useTranslations("campaignPage.filters");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // The ticks change at once (local state); the server's answer then replaces them.
  const fromServer = JSON.stringify(groups.map((g) => [g.name, g.selected]));
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(groups.map((g) => [g.name, g.selected]))
  );
  useEffect(() => {
    setSelected(Object.fromEntries(JSON.parse(fromServer) as [string, string[]][]));
  }, [fromServer]);
  const activeCount = Object.values(selected).reduce((n, v) => n + v.length, 0);
  const shownGroups = groups.map((g) => ({ ...g, selected: selected[g.name] ?? [] }));

  function apply(next: Record<string, readonly string[]>) {
    setSelected(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, [...v]])));
    startTransition(() => {
      router.replace(
        { pathname: "/campaigns", query: listQuery({ ...keep, causes: next.cause ?? [], countries: next.country ?? [] }) },
        { scroll: false }
      );
    });
  }
  const onToggle = (name: string, value: string) => apply({ ...selected, [name]: toggleValue(selected[name] ?? [], value) });
  const clearAll = () => apply({});

  const groupsFor = (prefix: string) =>
    shownGroups.map((g) => <FilterGroup key={g.name} group={g} idPrefix={prefix} onToggle={onToggle} />);

  return (
    <>
      <aside className="ch-filter-sidebar" aria-label={t("title")} aria-busy={pending || undefined}>
        <div className="ch-filter-head">
          <h2 className="ch-filter-title">{t("title")}</h2>
          {activeCount > 0 && (
            <button type="button" className="ch-btn ch-btn-ghost ch-filter-clear" onClick={clearAll}>
              {t("clearAll")}
            </button>
          )}
        </div>
        <form method="get" action={`/${locale}/campaigns`} onSubmit={(e) => hydrated && e.preventDefault()}>
          {keep.q && <input type="hidden" name="q" value={keep.q} />}
          {keep.sort !== DEFAULT_CAMPAIGN_SORT && <input type="hidden" name="sort" value={keep.sort} />}
          {groupsFor("f")}
          {!hydrated && (
            <div className="ch-filter-apply">
              <button type="submit" className="ch-btn">
                {t("apply")}
              </button>
            </div>
          )}
        </form>
      </aside>

      <div className="ch-filter-mobile-bar">
        <Sheet>
          <SheetTrigger asChild>
            <button type="button" className="ch-btn ch-filter-open">
              {activeCount > 0 ? t("openWithCount", { count: activeCount }) : t("open")}
            </button>
          </SheetTrigger>
          <SheetContent side="bottom" className="ch-filter-sheet" aria-describedby={undefined}>
            <div className="ch-filter-sheet-head">
              <SheetTitle className="ch-filter-title">{t("title")}</SheetTitle>
              <SheetClose className="ch-btn ch-btn-ghost">{t("close")}</SheetClose>
            </div>
            <div className="ch-filter-sheet-body" aria-busy={pending || undefined}>
              {groupsFor("m")}
            </div>
            <div className="ch-filter-sheet-foot">
              <button type="button" className="ch-btn ch-btn-ghost" onClick={clearAll} disabled={activeCount === 0}>
                {t("clearAll")}
              </button>
              <SheetClose className="ch-btn ch-btn-primary">{t("showResults", { count: total })}</SheetClose>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}

function FilterGroup({
  group,
  idPrefix,
  onToggle,
}: {
  group: FilterGroupData;
  idPrefix: string;
  onToggle: (name: string, value: string) => void;
}) {
  const t = useTranslations("campaignPage.filters");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = visibleOptions(group.options, group.selected, query, expanded);
  const listId = `${idPrefix}-${group.name}-options`;
  const title = t(group.name);

  return (
    <details className="ch-filter-group" open>
      <summary className="ch-filter-summary">
        <span>{title}</span>
        {group.selected.length > 0 && (
          <span className="ch-filter-badge" aria-label={t("chosen", { count: group.selected.length })}>
            {group.selected.length}
          </span>
        )}
      </summary>
      <div className="ch-filter-group-body">
        {group.options.length > SEARCH_FROM && (
          <input
            type="search"
            className="ch-filter-search"
            placeholder={t(`search.${group.name}`)}
            aria-label={t(`search.${group.name}`)}
            aria-controls={listId}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <ul id={listId} className="ch-filter-options">
          {shown.map((o) => {
            const id = `${idPrefix}-${group.name}-${o.value}`;
            return (
              <li key={o.value}>
                <input
                  type="checkbox"
                  id={id}
                  className="ch-filter-check"
                  name={group.name}
                  value={o.value}
                  checked={group.selected.includes(o.value)}
                  onChange={() => onToggle(group.name, o.value)}
                />
                <label htmlFor={id} className="ch-filter-option">
                  <span className="ch-filter-option-label">{o.label}</span>
                  <span className="ch-filter-count" aria-label={t("campaignCount", { count: o.count })}>
                    {o.count}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {shown.length === 0 && <p className="ch-filter-none">{t("noOptions", { query })}</p>}
        {!query && group.options.length > COLLAPSED_LIMIT && (hidden > 0 || expanded) && (
          <button
            type="button"
            className="ch-btn ch-btn-ghost ch-filter-more"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? t("showFewer") : t("showAll", { count: group.options.length })}
          </button>
        )}
      </div>
    </details>
  );
}
