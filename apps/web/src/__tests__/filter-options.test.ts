import { describe, expect, it } from "vitest";
import {
  COLLAPSED_LIMIT,
  filterQuery,
  normalise,
  sortOptions,
  toggleValue,
  visibleOptions,
  type FilterOption,
} from "@/lib/campaigns/filter-options";

// TASK-042: the filter sidebar's list logic.

const opts = (n: number): FilterOption[] =>
  Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Option ${i}`, count: n - i }));

describe("filter options", () => {
  it("sorts by count, then by label", () => {
    const sorted = sortOptions(
      [
        { value: "b", label: "Beta", count: 2 },
        { value: "a", label: "Alpha", count: 2 },
        { value: "c", label: "Gamma", count: 5 },
      ],
      "en"
    );
    expect(sorted.map((o) => o.value)).toEqual(["c", "a", "b"]);
  });

  it("shows the first few, keeps chosen options visible and counts the rest", () => {
    const list = opts(200);
    const collapsed = visibleOptions(list, [], "", false);
    expect(collapsed.shown).toHaveLength(COLLAPSED_LIMIT);
    expect(collapsed.hidden).toBe(200 - COLLAPSED_LIMIT);

    const withChoice = visibleOptions(list, ["v150"], "", false);
    expect(withChoice.shown.map((o) => o.value)).toContain("v150");
    expect(withChoice.hidden).toBe(200 - COLLAPSED_LIMIT - 1);

    expect(visibleOptions(list, [], "", true)).toEqual({ shown: list, hidden: 0 });
    expect(visibleOptions(opts(4), [], "", false)).toEqual({ shown: opts(4), hidden: 0 });
  });

  it("a search shows every match, ignoring case and accents", () => {
    const list: FilterOption[] = [
      { value: "CZ", label: "Česko", count: 1 },
      { value: "CH", label: "Switzerland", count: 1 },
      { value: "CL", label: "Chile", count: 1 },
    ];
    expect(visibleOptions(list, [], "  CES ", false).shown.map((o) => o.value)).toEqual(["CZ"]);
    expect(visibleOptions(opts(200), [], "option 19", false).shown.map((o) => o.value)).toEqual([
      "v19", "v190", "v191", "v192", "v193", "v194", "v195", "v196", "v197", "v198", "v199",
    ]);
    expect(visibleOptions(list, [], "zzz", false)).toEqual({ shown: [], hidden: 0 });
    expect(normalise("Ćevapi Žar")).toBe("cevapi zar");
  });

  it("toggles values and builds the URL query without empty groups", () => {
    expect(toggleValue(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleValue(["a", "b"], "a")).toEqual(["b"]);
    expect(filterQuery({ cause: ["animals"], country: [] })).toEqual({ cause: ["animals"] });
    expect(filterQuery({})).toEqual({});
  });
});
