# TASK-018 feedback — public API, llms.txt, sitemap
Spec: `docs/tasks/TASK-018-public-api-seo.md`.

## 018a — sitemap, llms.txt
Status: DONE — Live on dev (PR #184)

### What I implemented
- `lib/seo/sitemap.ts` + routes `app/sitemap.xml/route.ts`, `app/sitemaps/[file]/route.ts`: index of `pages.xml`, `campaigns.xml` (DEPLOYED with a contract, not demo, lastmod = updated) and `organizations-<n>.xml` (listed Trust Score rows in `org_id` order, 40,000 per file, lastmod = score date); unknown or past-the-end files 404; `Cache-Control` 1 h (index) / 1 day (files). Outside the next-intl middleware (not in its matcher).
- `robots.txt` on prod ends with `Sitemap: https://app.cherr.io/sitemap.xml`; non-prod unchanged (crawlers blocked).
- `/llms.txt` (`lib/seo/llms.ts`): what CHERR.IO is, main pages, Trust Score v1 in short (weights from `@cherrio/shared/trust`), sitemap and licences links.

### Test results
`src/__tests__/sitemap.test.ts` (4) + `admin-hidden.test.ts` (robots): `Tests 13 passed (13)`. Deliberate break (unlisted organisations not filtered):
```
   × sitemaps > lists listed organisation profiles only, with the score date as lastmod 14ms
      Tests  1 failed | 3 passed (4)
```
restored → passing. Speed on a scratch database with 615,000 listed organisations and a 30 s statement timeout:
```
index 18 files 136 ms
file 0: 40000 urls, 5.2 MB, 444 ms
file 7: 40000 urls, 5.2 MB, 709 ms
file 15: 15000 urls, 2.0 MB, 833 ms
```

### Not done
- Search engines will read it only on prod (dev/uat block crawlers by design).

## 018b — public read API v1
Status: DONE (Built; PR pending)

### What I implemented
- Routes `GET /api/v1/organizations` (Market Cap filters `q`, `country`, `cause`, `on`, `sort`, `limit` 1–100, cursor `after` → `next`/`nextUrl`), `/api/v1/organizations/{id}` (score parts, ratings average/count, register facts from a fixed allow-list of fields), `/api/v1/campaigns` (`cause`, `country`, `q`, `sort`, `page`), `/api/v1/campaigns/{slug}` (with story), `/api/v1/openapi.json` (OpenAPI 3.1, `lib/api/openapi.ts`). All read-only, no login, CORS `*` for GET/OPTIONS, `Cache-Control: public` 60–300 s (errors `no-store`), 120 requests/min per IP (`apiRateLimiter`, 429 + `Retry-After`). Money as strings of base units.
- `/en/docs/api`: reference rendered from the same OpenAPI document (endpoints, parameters, responses, curl lines); in the sitemap and `/llms.txt`.
- New dev dependency `ajv@8.20.0` (already in the lockfile through other packages) — tests validate real responses against the document's schemas.

### Test results
`src/__tests__/api-v1.test.ts` (5: list + cursor validated against the schema; detail validated, an unlisted register field never leaves the API; campaigns validated, unknown/odd slugs 404; rate limit 429; document paths) and `sitemap.test.ts`: `Tests 9 passed (9)`. Deliberate break (score as a number instead of a string):
```
   × public API v1 > lists organisations with a cursor, as the OpenAPI schema says 120ms
      Tests  1 failed | 4 passed (5)
```
restored → passing. E2E (local build, `CI=1`): `api-v1.spec.ts` both viewports `2 passed`; a11y for `/en/docs/api` light/dark included in `10 passed` (first API run failed on an ambiguous heading match — fixed with `exact: true`). Screenshot at 1440 checked.

### Not done
- No API keys or per-client quotas (public data, IP limit only); an MCP server reading the same API is a later task (Product spec §8).
