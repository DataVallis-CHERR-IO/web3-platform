// Filter sidebar logic for the public campaign list (TASK-042), kept pure so
// it is unit-tested without a browser. A group lists its options by count
// (most campaigns first), shows the first few and offers "Show all"; a search
// box appears when the group is long, so a list of hundreds stays usable.

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

/** Options shown before "Show all". */
export const COLLAPSED_LIMIT = 6;
/** A group with more options than this gets a search box. */
export const SEARCH_FROM = 8;

/** Lower case without accents: "Česká" matches "ceska". */
export function normalise(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/** Most campaigns first, then by label. */
export function sortOptions(options: FilterOption[], locale: string): FilterOption[] {
  return [...options].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, locale));
}

/**
 * Which options a group shows. A search shows every match; otherwise the
 * first `COLLAPSED_LIMIT` (or all when expanded). Chosen options are always
 * shown, so a choice never disappears behind "Show all".
 */
export function visibleOptions(
  options: FilterOption[],
  selected: readonly string[],
  query: string,
  expanded: boolean
): { shown: FilterOption[]; hidden: number } {
  const q = normalise(query);
  if (q) {
    const shown = options.filter((o) => normalise(o.label).includes(q));
    return { shown, hidden: 0 };
  }
  if (expanded || options.length <= COLLAPSED_LIMIT) return { shown: options, hidden: 0 };
  const shown = options.filter((o, i) => i < COLLAPSED_LIMIT || selected.includes(o.value));
  return { shown, hidden: options.length - shown.length };
}

/** Adds the value when missing, removes it when present. */
export function toggleValue(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

/** URL query for the list: only groups with values; the page resets to 1. */
export function filterQuery(groups: Record<string, readonly string[]>): Record<string, string[]> {
  const query: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(groups)) if (values.length > 0) query[name] = [...values];
  return query;
}
