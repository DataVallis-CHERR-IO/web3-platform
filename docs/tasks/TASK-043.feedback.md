# TASK-043 feedback
Status: DONE (Built; Live on dev after merge + deploy — the real fal call needs David's check on dev)

## What I implemented
- `lib/demo/cover-models.ts`: `DEMO_COVER_MODELS`, `DEFAULT_COVER_MODEL = "flux-2-pro"`, `falModel`, `falQueueUrl`, `parseCoverModel` (unknown → default).
- `lib/demo/cover.ts`: `startDemoCover` / `finishDemoCover` take `model`; request body = prompt + the model's fields; status and result URLs use the model's queue; pending results carry `model`; audit `demo.cover_generated` data `{ model: <endpoint>, requestId, key }`. `FAL_QUEUE` stays as the Nano Banana URL for existing callers.
- Routes `POST …/cover { model }` and `POST …/cover/check { requestId, model }`.
- Browser loop `covers.ts` sends the model in both requests; `CoverGenerator` takes `model` (auto mode) or shows its own choice (manual "Generate missing covers"); new `CoverModelChoice` radio group; `DemoForm` has "Cover images" (FLUX.2 [pro] preselected).
- Strings `admin.demo.coverModel.*`; progress line "Generating cover 1 of 4 with FLUX.2 [pro] on fal.ai…".
- Owner guide v1.6 (§8), change log, PDF rebuilt (17 pages). ADR-052 row notes the amendment.

## Files changed
- `apps/web/src/lib/demo/cover-models.ts` (new), `apps/web/src/lib/demo/cover.ts`
- `apps/web/src/app/api/admin/demo-campaigns/[id]/cover/route.ts`, `…/cover/check/route.ts`
- `apps/web/src/app/[locale]/admin/demo/{covers.ts,CoverGenerator.tsx,CoverModelChoice.tsx (new),DemoForm.tsx}`
- `apps/web/messages/en.json`, `apps/web/src/__tests__/demo-covers.test.ts`, `apps/web/e2e/admin-demo.spec.ts`
- docs: this spec, `docs/03-DECISIONS.md` (ADR-052 note), `docs/tasks/README.md`, `docs/technical/04-web-app-and-auth.md`, `docs/technical/09-status-and-roadmap.md`, `docs/guides/owner/contracts-owner-guide.md` (v1.6), `docs/guides/owner/README.md`, `docs/guides/owner/dist/CHERR.IO-Contracts-Owner-Guide-v1.6.pdf` (v1.5 removed)

## Deviations from the task (and why)
- FLUX.2 [pro] request fields (`image_size: "landscape_4_3"`, `output_format: "jpeg"`) follow fal's FLUX.2 text-to-image schema as known; fal.ai's docs page could not be opened from the session (the fetch permission was not granted in time) and fal.ai is unreachable from the sandbox, so **the real FLUX.2 call is NOT RUN here**. If fal rejects a field, the admin sees "N generated, N failed" and the server log shows `[demo.cover] fal submit failed: flux-2-pro <status>`; Nano Banana Pro stays available.
- Prices in the admin text ("about $0.03" / "about $0.15 per image") are fal's list prices as known in October 2026, marked "may change".

## New dependencies
- none

## How to verify
On dev after the deploy: https://dev.cherr.io/en/admin/demo → form section **"Cover images"** with "FLUX.2 [pro] — cheaper (about $0.03 per image)" selected → create 1 organisation × 1 campaign → "Generating cover 1 of 1 with FLUX.2 [pro] on fal.ai…" → "1 cover generated." and the campaign has a photo. Then try "Nano Banana Pro" the same way.

## Test results (real outputs, this session, 2026-10-05)
`pnpm exec vitest run src/__tests__/demo-covers.test.ts`:
```
 ✓ src/__tests__/demo-covers.test.ts (9 tests) 170ms
      Tests  9 passed (9)
```
Deliberate break (check always uses the default model's queue URL), then restored:
```
   × demo covers (Postgres) > Nano Banana Pro on request: its own queue URL and fields, also when checking (TASK-043) 8ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
      Tests  1 failed | 8 passed (9)
```
E2E `admin-demo.spec.ts` after `pnpm build`:
```
  ✓  2 [chromium-1440] › e2e/admin-demo.spec.ts:24:1 › an admin sees the demo form, accessible, and an invalid wallet is refused (2.5s)
  ✓  4 [chromium-390] › e2e/admin-demo.spec.ts:24:1 › an admin sees the demo form, accessible, and an invalid wallet is refused (2.4s)
```
`pnpm --filter web test`: `Tests  468 passed (468)`; typecheck exit 0, lint exit 0, `pnpm check:design` → "Design check passed — no violations found.". Owner guide build: `PDF …/CHERR.IO-Contracts-Owner-Guide-v1.6.pdf  (17 pages)`.

## docs/technical chapters updated
- `04-web-app-and-auth.md` (`/en/admin/demo` covers; cover API rows)
- `09-status-and-roadmap.md` (TASK-043 row; TASK-042 Live on dev)

## Suggested commit message
feat(web): FLUX.2 [pro] for demo covers, chosen by the admin (TASK-043)
