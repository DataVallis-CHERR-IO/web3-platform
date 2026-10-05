import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// TASK-041: every design-system class (`ch-*`) used in a component must be
// defined in the shared stylesheets. `ch-container` was used by 21 account and
// admin pages but defined nowhere, so those pages ran from edge to edge.

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const styles = ["packages/ui/src/styles/components.css", "packages/ui/src/styles/theme.css"];
const sources = ["apps/web/src", "packages/ui/src"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : files(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/** `ch-*` tokens inside className="…", className={`…`} and cn("…", …) calls. */
export function usedClasses(source: string): string[] {
  const found = new Set<string>();
  const chunks = [
    ...source.matchAll(/className=\{?[`"]([^`"]*)[`"]/g),
    ...source.matchAll(/\bcn\(([^)]*)\)/g),
  ].map((m) => m[1] ?? "");
  for (const chunk of chunks) for (const [token] of chunk.matchAll(/\bch-[a-z0-9-]+/g)) found.add(token);
  return [...found];
}

describe("design-system classes", () => {
  it("finds classes in className strings, template literals and cn() calls", () => {
    expect(
      usedClasses('<div className="ch-a flex"><p className={`ch-b ${x}`} /><i className={cn("ch-c", y && "ch-d")} /></div>').sort()
    ).toEqual(["ch-a", "ch-b", "ch-c", "ch-d"]);
  });

  it("every ch-* class used in a component is defined in the shared CSS", () => {
    const css = styles.map((f) => readFileSync(join(root, f), "utf8")).join("\n");
    const defined = new Set([...css.matchAll(/\.(ch-[a-z0-9-]+)/g)].map((m) => m[1]));
    const missing: string[] = [];
    for (const dir of sources) {
      for (const file of files(join(root, dir))) {
        for (const cls of usedClasses(readFileSync(file, "utf8"))) {
          if (!defined.has(cls)) missing.push(`${cls} (${file.slice(root.length)})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
