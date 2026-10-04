# TASK-033e feedback — lifecycle email and vote points
Status: DONE — parts 1–3 live on dev (PR #86, #87, #88). Email sending is off until David sets the SMTP secrets (CHEATSHEET §11.1); points and queueing run.

Spec: `docs/tasks/TASK-033-voting-lifecycle.md` §033e. Decisions: ADR-045 §5/§7, **ADR-048** (new).

## David's decisions (2026-10-04)
- SMTP host `mail.datavallis.com`, sender `hello@cherr.io` (not Gmail). User and password are secrets, entered by David.
- Worker **without Redis**: Postgres is the queue (recommended option chosen) → ADR-048.
- The Deploy workflow may create the worker container on **dev** (uat/prod stay David's).

## Part 1 — what I implemented (branch `feat/TASK-033e-worker`)
- **ADR-048**: Postgres outbox instead of Redis/BullMQ for Phase 1; vote points rule (200 per user, campaign and round, both Status and Reward balance); which emails, when, to whom; SMTP config vs secrets; consent (login email: service notices with one-click unsubscribe; wallet-only: double opt-in).
- **Migration `0009`**: `app.notifications` (outbox, unique per user, kind and event), `app.notification_preferences` (unsubscribe, contact email with double opt-in fields, unsubscribe token), `points_ledger.ref_key` + partial unique index `points_ledger_auto_uniq`. `eraseUser` deletes both new tables' rows.
- **`apps/worker`** rewritten (the BullMQ health skeleton removed; `bullmq`/`ioredis` dropped):
  - `points.ts` `awardVotePoints` — from `chain.vote` × `user_addresses` × `campaigns`; idempotent `on conflict … do nothing`; recomputes `user_levels.status_points` / `reward_points` for the users who got points.
  - `notify/enqueue.ts` `enqueueLifecycle` — VOTE_OPENED (round opened in the last 2 days, still open), VOTE_REMINDER (≤ 24 h left, > 10 min left, window > 2 days, the donor address has not voted), VOTE_RESULT (closed in the last 2 days), REFUND_AVAILABLE (FAILED/REJECTED, settlement started in the last 7 days, donor not settled, not swept; refund vs pool from the preference). Only users with notifications on and an address (confirmed contact email or login email).
  - `notify/send.ts` `sendPending` — one row per transaction, `FOR UPDATE SKIP LOCKED`; resolves the recipient now; skips unsubscribed, no-email and rows older than 3 days; creates the unsubscribe token on first send; `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058); backoff 5/10/20/40 min, FAILED after 5 attempts; removes the confirmation token from `data` once sent.
  - `notify/templates.ts` — subject, text and HTML per kind; database values escaped in HTML.
  - `mailer.ts` (nodemailer; 587 STARTTLS required, 465 TLS), `config.ts` (no SMTP credentials → sending off, the rest still runs), `run.ts` (one tick; a missing `chain.*` view skips the chain steps), `index.ts` (60 s loop, `/health` on 8080, graceful SIGTERM).
  - Build: one esbuild bundle `dist/index.mjs` (like the indexer's operator scripts).

## Files changed (part 1)
- `docs/03-DECISIONS.md` — ADR-048.
- `packages/db/src/schema/notifications.ts` (new), `enums.ts`, `social.ts`, `index.ts`; `drizzle/0009_nasty_havok.sql` + snapshot/journal; `src/gdpr.ts`; `src/__tests__/integration.test.ts` (24 tables; erase deletes notification rows).
- `apps/worker/` — `package.json`, `tsconfig.json`, `src/{config,mailer,points,run,index}.ts`, `src/notify/{enqueue,send,templates}.ts`, `test/worker.test.ts`; removed `src/queues/health.ts`, `src/workers/health.ts`, `test/health.test.ts`.
- `pnpm-lock.yaml`.
- `docs/technical/01`, `03`, `09`.

## Deviations
- **Redis/BullMQ (MANIFEST §4, Architecture §4.3) not used** — David's decision, ADR-048.
- **Email texts live in the worker** (`templates.ts`), not in next-intl message files: the worker is a separate service and the texts are not web UI. English only, like the web app.
- **Points in both balances**: Product Spec §3 lists one number per action and two balances per user; I credit 200 to Status *and* 200 to Reward (written into ADR-048). One line to change if David means only one.
- The 24 h reminder is skipped for vote windows of 2 days or less (the 1-hour Amoy test window would otherwise send "opened" and "reminder" at once).

## New dependencies
- `nodemailer@^7.0.9`, `@types/nodemailer@^7.0.2` — SMTP client (worker only).
- `esbuild@^0.28.2` (dev, worker) — already used by `packages/db` and the indexer.
- `@cherrio/db`, `drizzle-orm@^0.39.3` (worker) — already in the repo.
- Removed from the worker: `bullmq`, `ioredis`.

## Test results (part 1, local sandbox, 2026-10-04)
```
$ pnpm --filter worker test
      Tests  6 passed (6)
$ pnpm --filter @cherrio/db test:integration
 ✓ src/__tests__/integration.test.ts (16 tests) 766ms
      Tests  16 passed (16)
$ pnpm --filter worker build
  dist/index.mjs  757.4kb
⚡ Done in 74ms
$ node dist/index.mjs (APP_BASE_URL=http://localhost:3000, HEALTH_PORT=18080, no SMTP), curl /health
ok 200
[worker] started; email sending off (no SMTP credentials)
$ pnpm --filter worker lint / typecheck → no output, exit 0
```
First run of the new tests: 1 failed on my test, not the code — an "old" round that still closed within 24 h correctly got a reminder; the test round now closes in 3 days.

Deliberate breaks (restored → `Tests 6 passed (6)`):
1. Recipient filter without `coalesce(p.email_enabled, true)` → `× email queue > vote opened … → expected [ { kind: 'VOTE_OPENED', …(2) } ] to deeply equal []`
2. Confirmation token kept in `data` after sending → `× sending > … → expected { …(2) } to deeply equal { email: 'new-muu1brbe@example.com' }`
```
      Tests  2 failed | 4 passed (6)
```

## Open questions / risks
- Points in both balances (above).
- Until part 3 is deployed, the unsubscribe and confirmation links in emails point to routes that do not exist yet; no email is sent before SMTP credentials are set, so nobody receives such a link.
- `awardVotePoints` scans every indexed vote each minute (idempotent). Fine for Phase 1 volumes; add a watermark if `chain.vote` grows large.

## Suggested commit message
feat(worker): lifecycle email outbox and vote points without Redis (TASK-033e part 1, ADR-048)

---

## Part 1 merged and deployed
- PR #86 squash-merged (`a99e418`), CI green (incl. the new "Test worker" step and the indexer scenario); Deploy run 37217864753 success — migration `0009` ran in the web deploy job.

## Part 2 — worker deploy (branch `feat/TASK-033e-worker-deploy`)
- `Dockerfile.worker`: bundle stage (`pnpm install --filter 'worker...'`, esbuild) → runner with one file `index.mjs`, non-root user, `HEALTHCHECK` on `/health`.
- `config/worker.yml` + `config/worker.dev.yml`: service `cherrio-worker-dev`, no proxy, 192 MB, `APP_BASE_URL=https://dev.cherr.io`, `SMTP_HOST=mail.datavallis.com`, `SMTP_PORT=587`, `MAIL_FROM="CHERR.IO <hello@cherr.io>"`, secret `DATABASE_URL` (the web role through PgBouncer, already in `.kamal/secrets-common`).
- `.github/workflows/deploy.yml`: jobs "Worker — changed?" and "Worker — Build → Deploy → Health" (after the web job, so migrations ran first; path filter like the indexer's).
- `.github/workflows/ci.yml`: image build `worker` + a check that the bundle loads in the image (it must stop with `DATABASE_URL is required`).
- Docs: technical 05 (service row, memory budget without Redis), 08 §6a (worker operations), CHEATSHEET §11 (turn on email, daily commands), 09.

**Deviation:** I could not add `SMTP_USER` / `SMTP_PASSWORD` to `.kamal/secrets-common` — the session's settings deny any access to `.kamal/secrets*` (the write was refused). As for the indexer (TASK-026), David adds the two name lines; `config/worker.dev.yml` gets the two secret names in the same PR (Kamal refuses a secret name it cannot resolve). Until then the worker runs with sending off.

## Part 2 merged and deployed
- PR #87 squash-merged (`2319fb1`), CI green incl. the new "Image build (worker)" with the bundle-load check; Deploy run 37218865971: job "Worker — Build → Deploy → Health" success (Kamal waited for the container's HEALTHCHECK). The job log (first worker lines) is not readable from the cloud session; it should say `email sending off (no SMTP credentials)`.

## Part 3 — settings, double opt-in, unsubscribe (branch `feat/TASK-033e-preferences`)
- `lib/notifications/preferences.ts`: settings read model (`sendsTo` = contact email, else login email, when on), on/off, `requestContactEmail` (SHA-256 of a random token stored; raw token only in the queued `EMAIL_CONFIRM` row; 24 h validity; 3 requests per hour; refuses the login address), `confirmContactEmail` (second click on the same link still "confirmed"), `removeContactEmail`, `unsubscribeByToken`, `pointBalances`. Every change audited.
- Routes: `GET/PUT /api/me/notifications`, `POST/DELETE /api/me/notifications/email`, `GET /api/notifications/confirm?token=` (303 to `/en/notifications/confirmed?ok=1|0`), `POST /api/notifications/unsubscribe?token=` (RFC 8058 one-click; no origin check, the token is the credential; GET never unsubscribes).
- Pages: `/en/account/notifications` (status, switch, contact address with double opt-in, Proof of Charity points), `/en/notifications/confirmed`, `/en/notifications/unsubscribe` (button; `noindex` layout). Links from `/en/account` and, when no email would be sent, from "My donations".
- Docs: technical 04 (pages, routes), 05, 09; donors guide "Emails about your donations".

## Test results (part 3, local sandbox, 2026-10-04)
```
$ pnpm --filter web test
 Test Files  46 passed (46)
      Tests  416 passed (416)
$ pnpm check:design → Design check passed — no violations found.
$ pnpm build → ⚠ Compiled with warnings in 75s
$ CI=1 pnpm exec playwright test e2e/notifications.spec.ts --retries=0
  2 passed (13.5s)
$ pnpm --filter web lint / typecheck → exit 0
```
First E2E run failed on my locator (`getByLabel("Email address")` also matched a field outside the form); now scoped to the "Leave an email" section.

Deliberate break: the 24 h expiry removed from `confirmContactEmail` →
```
   × notification settings (Postgres) > an expired confirmation link does not confirm
     → expected 'http://localhost:3000/en/notification…' to be 'http://localhost:3000/en/notification…'
      Tests  1 failed | 4 passed (5)
```
Restored → `Tests 5 passed (5)`.

## Part 3 merged and deployed
- PR #88 squash-merged (`70ce814`), CI green; Deploy run 37220283985 success.

## Email turned on (2026-10-04, after PR #90)
- David set the GitHub Environment secrets `SMTP_USER` / `SMTP_PASSWORD` and added their names to `.kamal/secrets-common` (PR #90, merged after green CI).
- `config/worker.dev.yml`: the two secret names and `SMTP_PORT: "465"` (David: the server needs 465; the mailer uses implicit TLS on 465). Docs: CHEATSHEET §11.1, technical 05, ADR-048 wording.
