# testnet.cherr.io alias — feedback
Status: DONE — part 1 live on dev (PR #218, Deploy 38262816340); part 2 (public name) Built

David, 2026-10-12: "lahko dam dev.cherr.io domeno tudi na testnet.cherr.io … da lahko delim okoli … najlažje bi mi bilo da je dev==testnet, da samo dns zapis za domeno damo pa konfiguriramo strežnik. branch pa ostane dev zaenkrat."

## What I implemented
- `config/deploy.dev.yml`: `proxy.host: dev.cherr.io,testnet.cherr.io` — kamal-proxy routes both names to the same dev container and issues a Let's Encrypt certificate per name.
- `apps/web/src/lib/security/origin.ts`: `getAllowedOrigins(appEnv)`; `verifyOrigin` accepts every allowed origin. dev = `https://dev.cherr.io` + `https://testnet.cherr.io`; uat and prod unchanged (one origin each).
- Test `accepts the testnet alias on dev only` in `apps/web/src/__tests__/security.test.ts`: alias accepted on dev (Origin and Referer), refused on uat/prod, look-alike `testnet.cherr.io.evil.com` and `http://` refused.

## Why a comma-separated `host` and not `hosts:`
`config/deploy.yml` sets `proxy.host: placeholder.cherr.io`; Kamal deep-merges the destination file over it. Kamal 2.12.0 (`lib/kamal/configuration/validator/proxy.rb`) refuses a proxy section with both keys ("Specify one of 'host' or 'hosts', not both"), and `lib/kamal/configuration/proxy.rb` reads `proxy_config["hosts"] || proxy_config["host"]&.split(",")`. Checked against the v2.12.0 source and a merge simulation:

```
config/deploy.dev.yml: keys=["host"] both_error=false hosts=["dev.cherr.io", "testnet.cherr.io"]
hosts-variant keys=["host", "hosts"] -> would be refused
```

## Deliberate break
Loosened the Referer check to `allowed.some((o) => referer.startsWith(o))`:

```
   × Origin verification > accepts the testnet alias on dev only 9ms
     → expected true to be false // Object.is equality
      Tests  1 failed | 12 passed (13)
```

Restored with the reverse `sed`: `Tests  13 passed (13)`.

## Test results
- `pnpm --filter web test`: `Test Files 78 passed (78)`, `Tests 626 passed (626)` (625 + 1 new). The first run right after the sandbox bootstrap had `1 failed | 625 passed (626)`; the re-run was clean — not related to this change (no origin test failed).
- `vitest run security.test.ts auth-api.test.ts`: `Tests 23 passed (23)`.
- `pnpm --filter web lint`, `pnpm --filter web typecheck`: no errors.
- NOT RUN — `kamal config -d dev` (needs the Kamal gem and the secrets file; the Deploy run on dev is the real check).

## Left out on purpose
- **Canonical public name stays `dev.cherr.io`** (emails, link previews, share links, sitemap, widget) — switching it to `testnet.cherr.io` needs David's yes and must wait until DNS and the Privy origin exist, or links would point to a name that does not work yet.
- No redirect from one name to the other: both serve the app; sessions are per host.
- `noindex` stays on the testnet name (non-prod).

## Needs David
1. DNS: `A` record `testnet.cherr.io` → the same address as `dev.cherr.io`.
2. Privy testnet app → allowed domains: add `https://testnet.cherr.io`.

## Docs updated
technical 04 (origin check), 05 ("Testnet alias" section, domains row), 09 (§2), `docs/CHEATSHEET.md`.

## Suggested commit message
feat(infra): serve the dev environment on testnet.cherr.io too

---

# Part 2 — testnet.cherr.io as the public name (2026-10-12)

David, 16:29: "ja, sem mergal, deluje https://testnet.cherr.io/en" — answering the proposal to make testnet.cherr.io the public name and redirect dev.cherr.io to it.

## What I implemented
- `apps/web/src/lib/security/hosts.ts` (new, no imports so the middleware stays small): `getExpectedOrigin("dev")` = `https://testnet.cherr.io`; `ALIAS_ORIGINS.dev` = `https://dev.cherr.io`; `legacyHostRedirect(appEnv, host, pathAndQuery)`. `origin.ts` re-exports `getExpectedOrigin` so existing callers are unchanged.
- `apps/web/src/middleware.ts`: GET/HEAD page requests whose host (`x-forwarded-host`, else `host`) is `dev.cherr.io` on `APP_ENV=dev` get a 308 to the same path + query on `testnet.cherr.io`. API routes are not redirected; `verifyOrigin` still accepts both origins on dev.
- `config/worker.dev.yml`: `APP_BASE_URL: https://testnet.cherr.io` (email links).
- Tests: `legacy-host.test.ts` (middleware: redirect keeps path + `?ref=`, works via `x-forwarded-host`; API, POST, testnet host and prod untouched), `security.test.ts` (`legacyHostRedirect` cases incl. `dev.cherr.io.evil.com`, `:443`, uat/prod; older origin still accepted), `notification-preferences.test.ts` expects the testnet redirect target.

## Deliberate break
`if (moved) return moved;` → `if (moved && false) return moved;`:

```
   × older dev host > redirects pages on dev.cherr.io to testnet.cherr.io, keeping path and query 24ms
     → expected [ 200, null ] to deeply equal [ 308, …(1) ]
      Tests  1 failed | 1 passed (2)
```

Restored with the reverse `sed`: `Tests  2 passed (2)`.

## Test results
- `pnpm --filter web test`: `Test Files 79 passed (79)`, `Tests 630 passed (630)`.
- `pnpm --filter worker test`: `Tests 40 passed (40)`.
- `pnpm --filter web lint`, `typecheck`: no errors; `pnpm check:design`: "Design check passed — no violations found."
- NOT RUN locally — `next build` (CI "Lint, Typecheck, Test & Build" and "Image build (web)" build it).

## Left out on purpose
- Health curls in the runbooks still use `https://dev.cherr.io/api/health` — API routes answer on both names, so they keep working.
- Old emails keep their dev.cherr.io links; pages redirect, the confirm link (`/api/…`) works on both names.
- No HSTS or other header changes.

## Docs updated (part 2)
technical 01, 03, 04, 05 ("Testnet name"), 06, 08, 09, 10; `docs/CHEATSHEET.md`, `README.md`.
