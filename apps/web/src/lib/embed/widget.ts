import type { PublicCampaign } from "@/lib/campaigns/public";
import { daysLeft, percentRaised } from "@/components/campaigns/public-display";
import { formatGoal } from "@/lib/campaigns/goal";

// Embeddable donate widget (TASK-019). A site adds
//   <script src="https://app.cherr.io/widget.js" async></script>
//   <cherrio-donate campaign="<slug>"></cherrio-donate>
// and gets an iframe with /embed/campaigns/<slug>: the campaign's organisation,
// title, progress and a Donate button that opens the campaign on CHERR.IO in a
// new tab (sign-in and wallets never run inside someone else's page).

export type EmbedTheme = "light" | "dark" | "auto";

export interface EmbedTexts {
  verified: string;
  donate: string;
  seeCampaign: string;
  ended: string;
  ofGoal: (percent: number, goal: string) => string;
  donors: (count: number) => string;
  daysLeft: (days: number) => string;
  lastDay: string;
  poweredBy: string;
  label: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const parseEmbedTheme = (v: string | null): EmbedTheme => (v === "light" || v === "dark" ? v : "auto");

export function embedHtml(campaign: PublicCampaign, t: EmbedTexts, opts: { campaignUrl: string; homeUrl: string; theme: EmbedTheme; locale: string }): string {
  const raised = campaign.onChain?.raised ?? 0n;
  const percent = Math.min(100, percentRaised(raised, campaign.targetUsdc));
  const goal = formatGoal(campaign.goal, opts.locale, { wholeOnly: true }); // ADR-060: the goal's own currency
  const state = campaign.onChain?.state ?? null;
  const open = state === "live";
  const days = daysLeft(campaign.deadline);
  const meta = [
    t.ofGoal(percent, goal),
    ...(campaign.onChain ? [t.donors(campaign.onChain.donors)] : []),
    ...(open ? [days === null ? t.ended : days === 0 ? t.lastDay : t.daysLeft(days)] : [t.ended]),
  ];
  const themeAttr = opts.theme === "auto" ? "" : ` data-theme="${opts.theme}"`;
  return `<!doctype html>
<html lang="${esc(opts.locale)}"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(campaign.title)} — CHERR.IO</title>
<link rel="stylesheet" href="/embed/tokens.css">
<style>
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{font-family:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}
.w{background:var(--surface-raised);border:3px solid var(--line);padding:16px;display:flex;flex-direction:column;gap:10px;max-width:420px}
.org{margin:0;font-size:13px;line-height:18px;color:var(--ink-muted);display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.v{color:var(--status-success-fill);font-weight:700}
h1{margin:0;font-size:18px;line-height:24px;font-weight:800;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bar{height:10px;background:var(--surface-sunken);border:2px solid var(--line);position:relative}
.bar>span{display:block;height:100%;background:var(--accent)}
.meta{margin:0;font-size:13px;line-height:18px;color:var(--ink-muted)}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.btn{display:inline-block;background:var(--accent);color:var(--on-accent);border:3px solid var(--line);padding:8px 16px;font-weight:800;font-size:14px;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;box-shadow:var(--shadow-hard-sm)}
.btn:hover{background:var(--accent-hover);color:var(--on-accent-strong)}
.btn:focus-visible,.by:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.btn.alt{background:var(--surface-raised);color:var(--ink)}
.by{font-size:12px;color:var(--wayfinding-text)}
</style>
</head>
<body>
<main class="w" aria-label="${esc(t.label)}">
<p class="org"><span>${esc(campaign.orgName)}</span>${campaign.orgVerified ? `<span class="v">✓ ${esc(t.verified)}</span>` : ""}</p>
<h1>${esc(campaign.title)}</h1>
<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="${esc(t.ofGoal(percent, goal))}"><span style="width:${percent}%"></span></div>
<p class="meta">${meta.map(esc).join(" · ")}</p>
<div class="row">
<a class="btn${open ? "" : " alt"}" href="${esc(opts.campaignUrl)}" target="_blank" rel="noopener">${esc(open ? t.donate : t.seeCampaign)}</a>
<a class="by" href="${esc(opts.homeUrl)}" target="_blank" rel="noopener">${esc(t.poweredBy)}</a>
</div>
</main>
<script>
(function(){function s(){parent.postMessage({cherrioHeight:document.documentElement.scrollHeight},"*")}
s();addEventListener("load",s);if(window.ResizeObserver)new ResizeObserver(s).observe(document.body)})();
</script>
</body>
</html>
`;
}

/** /widget.js: defines <cherrio-donate campaign="slug" theme="light|dark|auto">. */
export function widgetJs(origin: string, defaultTitle: string): string {
  return `/* CHERR.IO donate widget — ${origin}/en/docs/api */
(function () {
  if (!window.customElements || customElements.get("cherrio-donate")) return;
  var ORIGIN = ${JSON.stringify(origin)};
  class CherrioDonate extends HTMLElement {
    connectedCallback() {
      if (this.querySelector("iframe")) return;
      var slug = this.getAttribute("campaign") || "";
      if (!/^[a-z0-9-]{1,200}$/.test(slug)) return;
      var theme = this.getAttribute("theme");
      theme = theme === "light" || theme === "dark" ? theme : "auto";
      var frame = document.createElement("iframe");
      frame.src = ORIGIN + "/embed/campaigns/" + slug + "?theme=" + theme;
      frame.title = this.getAttribute("title") || ${JSON.stringify(defaultTitle)};
      frame.loading = "lazy";
      frame.style.cssText = "border:0;width:100%;max-width:420px;height:230px;display:block;color-scheme:normal";
      this.appendChild(frame);
      window.addEventListener("message", function (e) {
        if (e.origin !== ORIGIN || e.source !== frame.contentWindow) return;
        var h = Number(e.data && e.data.cherrioHeight);
        if (h > 0 && h < 2000) frame.style.height = Math.ceil(h) + "px";
      });
    }
  }
  customElements.define("cherrio-donate", CherrioDonate);
})();
`;
}

export function embedSnippet(origin: string, slug: string): string {
  return `<script src="${origin}/widget.js" async></script>\n<cherrio-donate campaign="${slug}"></cherrio-donate>`;
}
