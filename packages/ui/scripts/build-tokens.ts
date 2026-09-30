/**
 * packages/ui/scripts/build-tokens.ts
 * Reads design-system/tokens.json and writes src/styles/tokens.css.
 * Run: pnpm --filter ui tokens
 * CI check: git diff --exit-code packages/ui/src/styles/tokens.css
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

interface ColorToken {
  name: string;
  value: string | { light: string; dark: string };
}
interface SpacingToken { name: string; value: string }
interface RadiusToken { name: string; value: string }
interface BorderToken { name: string; value: string }
interface ShadowToken {
  name: string;
  value: string | { light: string; dark: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tokens: any = JSON.parse(
  readFileSync(join(root, "design-system/tokens.json"), "utf8"),
);

/** Resolve alias "{foo-bar}" → "var(--foo-bar)" */
function resolveAlias(v: string): string {
  return v.replace(/\{([^}]+)\}/g, (_, name: string) => `var(--${name})`);
}

const colorTokens: ColorToken[] = tokens.color.tokens;
const spacingTokens: SpacingToken[] = tokens.spacing.tokens;
const radiusTokens: RadiusToken[] = tokens.radius.tokens;
const borderTokens: BorderToken[] = tokens.border.tokens;
const shadowTokens: ShadowToken[] = tokens.shadow.tokens;
const families: Record<string, string> = tokens.type.families;

// ── Palette (theme-independent hex values) ─────────────────────────────────
const palette = colorTokens
  .filter((t) => typeof t.value === "string")
  .map((t) => `  --${t.name}: ${t.value as string};`)
  .join("\n");

// ── Light semantic aliases ──────────────────────────────────────────────────
const lightSemantics = colorTokens
  .filter((t) => typeof t.value === "object")
  .map((t) => {
    const v = t.value as { light: string; dark: string };
    return `  --${t.name}: ${resolveAlias(v.light)};`;
  })
  .join("\n");

// ── Dark semantic aliases ───────────────────────────────────────────────────
const darkSemantics = colorTokens
  .filter((t) => typeof t.value === "object")
  .map((t) => {
    const v = t.value as { light: string; dark: string };
    return `  --${t.name}: ${resolveAlias(v.dark)};`;
  })
  .join("\n");

// ── Light shadow values ─────────────────────────────────────────────────────
const lightShadows = shadowTokens
  .map((t) => {
    const v = typeof t.value === "string" ? t.value : (t.value as { light: string }).light;
    return `  --${t.name}: ${v};`;
  })
  .join("\n");

// ── Dark shadow values ──────────────────────────────────────────────────────
const darkShadows = shadowTokens
  .filter((t) => typeof t.value === "object")
  .map((t) => {
    const v = (t.value as { dark: string }).dark;
    return `  --${t.name}: ${v};`;
  })
  .join("\n");

// ── Static tokens (spacing, radius, border, fonts) ─────────────────────────
const staticTokens = [
  ...spacingTokens.map((t) => `  --${t.name}: ${t.value};`),
  ...radiusTokens.map((t) => `  --${t.name}: ${t.value};`),
  ...borderTokens.map((t) => `  --${t.name}: ${t.value};`),
  `  --font-display: ${families.display};`,
  `  --font-sans: ${families.sans};`,
  `  --font-mono: ${families.mono};`,
].join("\n");

const indent = (block: string, spaces: number) =>
  block
    .split("\n")
    .map((l) => (l.trim() ? " ".repeat(spaces) + l : l))
    .join("\n");

const css = `/* CHERR.IO tokens — generated from design-system/tokens.json. DO NOT EDIT BY HAND. */
/* Regenerate: pnpm --filter ui tokens */

:root, [data-theme="light"] {
${palette}
${lightSemantics}
${lightShadows}
}

/* System dark preference (unless explicitly set to light via cookie) */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${indent(darkSemantics, 4)}
${indent(darkShadows, 4)}
  }
}

/* Explicit dark theme from cookie / toggle */
[data-theme="dark"] {
${darkSemantics}
${darkShadows}
}

:root {
${staticTokens}
}
`;

writeFileSync(join(root, "src/styles/tokens.css"), css, "utf8");
console.log("tokens.css generated.");
