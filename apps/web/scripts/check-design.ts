/**
 * apps/web/scripts/check-design.ts
 * Design guard: fails CI if non-token hex colours, rounded-* Tailwind classes,
 * or user-facing string literals appear in app/ui source.
 *
 * Exclusions: token generation scripts, test files, this file itself.
 * Run: pnpm --filter web check:design
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = [
  join(process.cwd(), "../../apps/web/src"),
  join(process.cwd(), "../../packages/ui/src"),
];

// Patterns that indicate a violation
const RULES: Array<{ name: string; pattern: RegExp; exclude?: RegExp }> = [
  {
    name: "hardcoded hex colour",
    // Matches #rgb, #rrggbb, #rgba, #rrggbbaa — but NOT inside CSS variable values in tokens.css
    pattern: /#[0-9a-fA-F]{3,8}\b/,
    // Allow inside generated tokens.css and the design-guard script itself
    exclude: /tokens\.css$|build-tokens\.ts$|check-design\.ts$/,
  },
  {
    name: "Tailwind rounded-* class",
    // rounded-sm, rounded-md, rounded-lg, rounded-xl, rounded-full, rounded, rounded-none (Tailwind default utilities)
    // Allow rounded-none only if it maps to our radius-none (it's valid but we just use the token directly)
    pattern: /\brounded(?:-(?:sm|md|lg|xl|2xl|3xl|full|none))?\b/,
    exclude: /\.test\.|\.spec\.|check-design\.ts$|README/,
  },
  {
    name: "user-facing string literal (non-intl)",
    // Catches JSX text content that is NOT a translation call
    // Simple heuristic: JSX-context string that's not inside {t(…)} or {useTranslations}
    // Flags English words in JSX tags: <p>Some text</p>, <span>Hello</span>
    pattern: />\s*[A-Z][a-z ,'!?-]{8,}\s*</,
    // dev/ui is a dev-only component catalog — hard-coded demo strings are intentional there
    exclude: /\.test\.|\.spec\.|fixtures|messages|check-design|tokens|README|dev\/ui/,
  },
  {
    name: "hardcoded HTML attribute string (non-intl)",
    // Catches English text in aria-label, title, alt, placeholder attributes
    pattern: /(?:aria-label|title|alt|placeholder)="[A-Za-z][A-Za-z0-9 ,'!?.()-]{1,}"/,
    exclude: /\.test\.|\.spec\.|fixtures|messages|check-design|tokens|README|dev\/ui/,
  },
];

// File extensions to check
const EXTS = new Set([".tsx", ".ts", ".css"]);
// Directories to skip
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "design-system", "scripts", "__tests__", "test", "e2e"]);

function walk(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) results.push(...walk(full));
    } else if (EXTS.has(full.slice(full.lastIndexOf(".")))) {
      results.push(full);
    }
  }
  return results;
}

let violations = 0;
const repoRoot = join(process.cwd(), "../..");

for (const root of ROOTS) {
  let files: string[];
  try { files = walk(root); } catch { continue; }

  for (const file of files) {
    const rel = relative(repoRoot, file);
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");

    for (const rule of RULES) {
      if (rule.exclude?.test(rel)) continue;
      lines.forEach((line, i) => {
        if (rule.pattern.test(line)) {
          console.error(`FAIL [${rule.name}] ${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
          violations++;
        }
      });
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} design violation(s) found.`);
  process.exit(1);
} else {
  console.log("Design check passed — no violations found.");
}
