# TASK-018 — Public API, llms.txt, sitemap (Architecture §3, Product spec §8)

David 2026-10-08: "TASK-018: javni API, llms.txt in sitemap za približno 615.000 profilov, kar pomaga, da jih najdejo iskalniki."

## Parts
- **018a — discoverability:** `/sitemap.xml` index → `/sitemaps/pages.xml`, `/sitemaps/campaigns.xml` (published, not demo), `/sitemaps/organizations-<n>.xml` (listed profiles, 40,000 per file); `Sitemap:` line in robots.txt on prod; `/llms.txt` (llmstxt.org format) generated from the shared Trust Score constants. JSON-LD is already on profiles (TASK-017c).
- **018b — public read API v1:** `GET /api/v1/organizations` (Market Cap list: filters, order, cursor), `/api/v1/organizations/{id}`, `/api/v1/campaigns`, `/api/v1/campaigns/{slug}`; JSON, CORS `*` for GET, per-IP rate limit, OpenAPI 3.1 at `/api/v1/openapi.json`, a human page `/en/docs/api`. Amounts as strings (USDC 6 decimals). No personal data.

## Tests
Vitest against Postgres; E2E for the API page; speed on ~600k organisations; OpenAPI document validated against the responses.
