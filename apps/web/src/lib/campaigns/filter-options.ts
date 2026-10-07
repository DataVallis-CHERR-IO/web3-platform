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

/**
 * Order of the public list (TASK-053). Every order keeps live campaigns
 * first, so a donor never has to page past ended campaigns to give:
 * - `ending` (default): live by soonest deadline, then ended by latest end;
 * - `newest`: by publish time, newest first, within live / ended;
 * - `raised`: by amount raised, most first, within live / ended.
 */
export const CAMPAIGN_SORTS = ["ending", "newest", "raised"] as const;
export type CampaignSort = (typeof CAMPAIGN_SORTS)[number];
export const DEFAULT_CAMPAIGN_SORT: CampaignSort = "ending";
export const MAX_SEARCH_LENGTH = 100;

/** The sort from the URL; anything else is the default. */
export function parseCampaignSort(value: string | string[] | undefined): CampaignSort {
  const v = Array.isArray(value) ? value[0] : value;
  return (CAMPAIGN_SORTS as readonly string[]).includes(v ?? "") ? (v as CampaignSort) : DEFAULT_CAMPAIGN_SORT;
}

/** Everything the list URL carries (TASK-053): filters, search, sort and page. */
export interface ListState {
  causes: readonly string[];
  countries: readonly string[];
  q: string;
  sort: CampaignSort;
  page?: number;
}

/** URL query for a list link: only what is set; the default sort and page 1 are left out. */
export function listQuery(state: ListState): Record<string, string | number | string[]> {
  const query: Record<string, string | number | string[]> = filterQuery({ cause: state.causes, country: state.countries });
  if (state.q) query.q = state.q;
  if (state.sort !== DEFAULT_CAMPAIGN_SORT) query.sort = state.sort;
  if (state.page && state.page > 1) query.page = state.page;
  return query;
}
