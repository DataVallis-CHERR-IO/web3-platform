/**
 * TASK-061f: the testnet agents' page and its footer link exist on dev/local only.
 * On uat and prod the page is a 404 and the footer has no link — the crew does not
 * exist there (`agentCrewEnabled`). Read at request time from APP_ENV.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/i18n/routing", () => ({ Link: (props: { href: string; children: ReactNode }) => props.children }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));

const original = process.env.APP_ENV;
afterEach(() => {
  if (original === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = original;
});

/** Every `href` in a rendered (not mounted) element tree. */
function hrefs(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(hrefs);
  const props = (node as ReactElement<{ href?: string; children?: unknown }>).props ?? {};
  return [...(typeof props.href === "string" ? [props.href] : []), ...hrefs(props.children)];
}

describe("testnet agents' page by environment", () => {
  it.each(["uat", "prod"])("is a 404 on %s", async (env) => {
    process.env.APP_ENV = env;
    const { default: AgentsPage } = await import("@/app/[locale]/agents/page");
    await expect(AgentsPage({ params: Promise.resolve({ locale: "en" }) })).rejects.toThrow(/NEXT_(HTTP_ERROR_FALLBACK;404|NOT_FOUND)/);
  });

  it("the footer links it on dev and local only", async () => {
    const { AppFooter } = await import("@/components/AppFooter");
    const links = (env: string) => { process.env.APP_ENV = env; return hrefs(AppFooter()); };
    expect(links("dev")).toContain("/agents");
    expect(links("local")).toContain("/agents");
    expect(links("uat")).not.toContain("/agents");
    expect(links("prod")).not.toContain("/agents");
    expect(links("prod")).toContain("/contract-changes"); // the tree was walked
  });
});
