import { TRUST_SCORE_VERSION, TRUST_WEIGHTS } from "@cherrio/shared/trust";

// /llms.txt (TASK-018a, llmstxt.org format): a short, plain description of the
// site for language models and AI search, with links to the pages that matter.

export function llmsTxt(origin: string): string {
  const pct = (w: number) => `${Math.round(w * 100)} %`;
  return `# CHERR.IO

> CHERR.IO is a transparent charitable-donation platform. Donors give USDC on the Polygon blockchain; each campaign's money sits in its own smart-contract escrow and reaches the charity at once or in three milestone payouts that donors approve by vote. Every donation, vote and payout is public on the blockchain. The Charity Market Cap ranks charities by a public, versioned Trust Score.

Operated by Data Vallis d.o.o. (Slovenia). Source code: https://github.com/DataVallis-CHERR-IO/web3-platform (MIT).

## Main pages

- [Campaigns](${origin}/en/campaigns): every published campaign, its goal, progress, donors and deadline.
- [Charity Market Cap](${origin}/en/charity-market-cap): charities ranked by Trust Score — organisations verified on CHERR.IO and charities from public registers (England and Wales Charity Commission; US IRS 501(c)(3) organisations that reported revenue).
- [How the Trust Score works](${origin}/en/charity-market-cap/methodology): the published method, version ${TRUST_SCORE_VERSION}.
- [How it works](${origin}/en/how-it-works)
- [Terms](${origin}/en/terms) and [Privacy](${origin}/en/privacy)

## Trust Score v${TRUST_SCORE_VERSION} in short

- Organisations on CHERR.IO: donor ratings ${pct(TRUST_WEIGHTS.rating)}, campaign success ${pct(TRUST_WEIGHTS.success)}, milestones approved by donors ${pct(TRUST_WEIGHTS.milestones)}, receipts delivered for payouts ${pct(TRUST_WEIGHTS.evidence)}, verification ${pct(TRUST_WEIGHTS.verification)}; 0–100.
- Charities from public registers (not on CHERR.IO): 20 + 20 × completeness of their public record, so 20–40, until they claim their listing and pass verification.
- Each charity has a profile page at ${origin}/en/charity-market-cap/<id> with its score, the parts of the score, ratings, campaigns and register facts, and schema.org Organization data.

## Optional

- [Sitemap](${origin}/sitemap.xml): every public page, including all charity profiles.
- [Licences](${origin}/en/licences): open-source and data licences (UK register data under the Open Government Licence v3.0).
`;
}
