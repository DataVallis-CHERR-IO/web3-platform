import tokens from "../../design-system/tokens.json";

// Design-token colours as plain values, for places that cannot use the CSS
// variables — e.g. link preview images rendered by next/og (TASK-055b).
// Source of truth stays design-system/tokens.json (ADR-022).

type ColorToken = { name: string; value: string | { light: string; dark: string } };
const COLORS = new Map((tokens.color.tokens as ColorToken[]).map((t) => [t.name, t.value]));

/** A colour token's value in the given theme, with `{other-token}` references resolved. */
export function tokenColor(name: string, theme: "light" | "dark" = "light"): string {
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    if (seen.has(current)) throw new Error(`token cycle at ${current}`);
    seen.add(current);
    const value = COLORS.get(current);
    if (value === undefined) throw new Error(`unknown colour token ${current}`);
    const raw = typeof value === "string" ? value : value[theme];
    const ref = /^\{(.+)\}$/.exec(raw);
    if (!ref) return raw;
    current = ref[1]!;
  }
}
