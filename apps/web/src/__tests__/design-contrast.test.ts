import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Design system v1.1 (ADR-041): every text/background pair the new tokens are
// used for must reach WCAG AA (4.5:1 for normal text) in both themes. The
// values are read from tokens.json, so a changed token is checked here.

type Theme = "light" | "dark";
type Token = { name: string; value: string | Record<Theme, string> };

const tokens: Token[] = JSON.parse(
  readFileSync(new URL("../../../../packages/ui/design-system/tokens.json", import.meta.url), "utf8")
).color.tokens;
const byName = new Map(tokens.map((t) => [t.name, t]));

/** A token's hex value in a theme, following `{alias}` references. */
export function resolve(name: string, theme: Theme, depth = 0): string {
  if (depth > 5) throw new Error(`alias loop at ${name}`);
  const token = byName.get(name);
  if (!token) throw new Error(`unknown token ${name}`);
  const raw = typeof token.value === "string" ? token.value : token.value[theme];
  const alias = /^\{([a-z0-9-]+)\}$/.exec(raw);
  if (alias) return resolve(alias[1]!, theme, depth + 1);
  if (!/^#[0-9a-f]{6}$/i.test(raw)) throw new Error(`${name} (${theme}) is not a hex colour: ${raw}`);
  return raw;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// [text, background, where it is used]
const PAIRS: [string, string, string][] = [
  ["on-status-success", "status-success-fill", "VERIFIED / SUCCEEDED / APPROVED chip, verified mark"],
  ["warning-700", "warning-50", "VOTING / IN REVIEW chip"],
  ["wayfinding-text", "cherry-50", "eyebrow in a tint band"],
  ["ink", "cherry-50", "text in a tint band"],
  ["ink-muted", "cherry-50", "muted note in a tint band"],
  ["wayfinding-text", "surface", "eyebrow, link and figure on the page ground"],
  ["wayfinding-text", "surface-raised", "eyebrow, figure, score, link and active nav item on raised surfaces"],
  ["ink-muted", "surface", "outline chip (DRAFT / IMPORTED) on the ground"],
  ["ink-muted", "surface-raised", "outline chip in a table"],
  ["line-soft", "ink", "eyebrow text on the Emergency Pool block"],
  ["surface", "ink", "step label on the dark step"],
];

describe("design tokens v1.1: contrast (WCAG AA, 4.5:1)", () => {
  for (const theme of ["light", "dark"] as const) {
    it.each(PAIRS)(`${theme}: %s on %s (%s)`, (text, background) => {
      const ratio = contrast(resolve(text, theme), resolve(background, theme));
      expect(ratio, `${text} on ${background} in ${theme}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("the contrast function matches known values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
});
