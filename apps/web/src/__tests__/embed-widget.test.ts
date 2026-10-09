import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { embedHtml, embedSnippet, widgetJs } from "@/lib/embed/widget";
import type { PublicCampaign } from "@/lib/campaigns/public";

// TASK-019: the widget page and script, without a server.

const texts = {
  verified: "Verified", donate: "Donate", seeCampaign: "See the campaign", ended: "Campaign ended",
  ofGoal: (p: number, g: string) => `${p} % of ${g} goal`, donors: (n: number) => `${n} donors`, daysLeft: (d: number) => `${d} days left`,
  lastDay: "Last day", poweredBy: "CHERR.IO", label: "Donate on CHERR.IO",
};
const campaign = (over: Partial<PublicCampaign> = {}): PublicCampaign => ({
  id: "c", slug: "paws", title: "Paws <script>alert(1)</script>", orgId: "o", orgName: "Shelter & Co", orgVerified: true,
  cause: "animals", country: "SI", coverUrl: null, goal: { currency: "EUR", minor: 1_500_000n }, targetUsdc: 1_000_000_000n,
  deadline: new Date(Date.now() + 3 * 86_400_000 + 3600_000), address: "0x1", isDemo: false, story: "",
  onChain: { state: "live", raised: 2_500_000_000n, payoutMode: null, donors: 4, endTime: 0n },
  ...over,
});
const opts = { campaignUrl: "https://x.example/en/campaigns/paws?utm_source=widget", homeUrl: "https://x.example/en", theme: "auto" as const, locale: "en" };

describe("donate widget", () => {
  it("escapes campaign text and caps the bar at 100 %", () => {
    const html = embedHtml(campaign(), texts, opts);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Paws &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Shelter &amp; Co");
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("4 donors · 3 days left");
    expect(html).toContain('href="https://x.example/en/campaigns/paws?utm_source=widget" target="_blank" rel="noopener">Donate<');
  });

  it("an ended campaign links to the campaign instead of asking for money", () => {
    const html = embedHtml(campaign({ onChain: { state: "completed", raised: 0n, payoutMode: "SINGLE", donors: 0, endTime: 1n } }), texts, opts);
    expect(html).toContain(">See the campaign<");
    expect(html).toContain("Campaign ended");
    expect(html).not.toContain(">Donate<");
  });

  it("the script only builds iframes for well-formed slugs, from our origin", () => {
    const js = widgetJs("https://app.cherr.io", "CHERR.IO campaign");
    expect(js).toContain('var ORIGIN = "https://app.cherr.io";');
    expect(js).toContain("/^[a-z0-9-]{1,200}$/.test(slug)");
    expect(js).toContain("e.origin !== ORIGIN");
    expect(embedSnippet("https://app.cherr.io", "paws")).toBe(
      '<script src="https://app.cherr.io/widget.js" async></script>\n<cherrio-donate campaign="paws"></cherrio-donate>'
    );
  });

  it("the widget's copy of the design tokens matches the design system", () => {
    const source = readFileSync(join(__dirname, "../../../../packages/ui/src/styles/tokens.css"), "utf8");
    const copy = readFileSync(join(__dirname, "../../public/embed/tokens.css"), "utf8");
    expect(copy, "run: cp packages/ui/src/styles/tokens.css apps/web/public/embed/tokens.css").toBe(source);
  });
});
