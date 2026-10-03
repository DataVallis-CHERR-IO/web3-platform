"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Field } from "@cherrio/ui";
import { usePathname, useRouter } from "@/i18n/routing";
import { LabeledSelect } from "@/components/LabeledSelect";
import { SearchableSelect } from "@/components/SearchableSelect";

/**
 * Filters of an admin list. The state lives in the URL (?q=…&status=…), so a
 * filtered list can be shared and the back button works. Typing in the search
 * box updates the list after a short pause; any change returns to page 1.
 */
export interface ListFiltersProps {
  searchLabel: string;
  searchHint?: string;
  selects: { key: string; label: string; value: string; options: { value: string; label: string }[] }[];
  countries?: { value: string; label: string }[];
}

export function ListFilters(props: ListFiltersProps) {
  const t = useTranslations("admin.list");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = React.useState(params.get("q") ?? "");
  const [pending, startTransition] = React.useTransition();

  const update = React.useCallback(
    (change: Record<string, string>) => {
      const next = new URLSearchParams(params.toString());
      next.delete("after");
      for (const [key, value] of Object.entries(change)) {
        if (value && value !== "all") next.set(key, value);
        else next.delete(key);
      }
      const query = next.toString();
      startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
    },
    [params, pathname, router]
  );

  // Debounced search.
  React.useEffect(() => {
    if (q === (params.get("q") ?? "")) return;
    const timer = setTimeout(() => update({ q: q.trim() }), 300);
    return () => clearTimeout(timer);
  }, [q, params, update]);

  return (
    <form
      role="search"
      className="ch-panel p-4 md:p-5 grid gap-4 md:grid-cols-2 lg:grid-cols-4 items-start"
      onSubmit={(event) => {
        event.preventDefault();
        update({ q: q.trim() });
      }}
      aria-busy={pending}
    >
      <Field
        id="admin-list-search"
        label={props.searchLabel}
        hint={props.searchHint}
        type="search"
        value={q}
        onChange={(event) => setQ(event.target.value)}
        autoComplete="off"
      />
      {props.selects.map((select) => (
        <LabeledSelect
          key={select.key}
          label={select.label}
          placeholder={t("any")}
          value={select.value}
          onChange={(value) => update({ [select.key]: value })}
          options={select.options}
        />
      ))}
      {props.countries && (
        <SearchableSelect
          label={t("country")}
          placeholder={t("anyCountry")}
          value={params.get("country") ?? ""}
          onChange={(value) => update({ country: value })}
          options={[{ value: "", label: t("anyCountry") }, ...props.countries]}
          noMatch={t("noCountry")}
        />
      )}
    </form>
  );
}
