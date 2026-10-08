# TASK-018 feedback — public API, llms.txt, sitemap
Spec: `docs/tasks/TASK-018-public-api-seo.md`.

## 018a — sitemap, llms.txt
Status: DONE (Built; PR pending)

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
