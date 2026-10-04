# TASK-033c feedback — fundraiser side: milestone evidence
Status: PARTIAL (parts 1–2 of 3 — part 1 merged as PR #80; part 2 dashboard UI; the public view on the campaign page follows)

Spec: `docs/tasks/TASK-033-voting-lifecycle.md` §033c. Decision: ADR-047 (David 2026-10-04: donors and the public see a **public summary only**; private files stay with the organisation's admins and platform admins).

## Part 1 — evidence data model, manifest, API (branch `feat/TASK-033c-evidence-api`)

### What I implemented
- **Migration `0008`**: enum `evidence_visibility` (`PRIVATE`/`PUBLIC`), `private_file_kind` + `EVIDENCE`; `evidence_bundles` + `note` (≤ 2,000, checked), `manifest`, `sealed_at`, `created_by` (check: manifest, hash and sealed_at null or set together); new table `evidence_files` (one of `private_file_id` / `public_key` per visibility, checked; SHA-256 format and size checks).
- **`apps/web/src/lib/campaigns/evidence.ts`**:
  - pure `buildManifest` (canonical JSON `cherrio.evidence/1`: fixed keys, lowercase campaign, files sorted by SHA-256, no whitespace), `manifestHash` (SHA-256 of the UTF-8 text as bytes32), `openRound` (PAYING + MILESTONES + payment 1 or 2 → round 0 / 1);
  - `addEvidenceFile` (private: encrypted `evidence/<campaignId>/<fileId>` + `private_files` row kind `EVIDENCE`; public: PDF unchanged / image → WebP without metadata, `campaigns/<id>/e-<random>.*`), limit 10, no duplicate hash, object removed on any refusal;
  - `removeEvidenceFile`, `setEvidenceNote`, `sealEvidence` (idempotent), `unsealEvidence` (only ≥ 10 min after sealing and while no vote round is on chain);
  - every write under a per-campaign advisory lock that refuses when `chain.vote_round` already has the round (`evidence_on_chain`);
  - readers: `listOwnEvidence` (fundraiser), `listPublicEvidence` (only bundles whose hash equals the chain's for that round), `publicManifest`, `openPrivateEvidenceFile` (audited).
- **Routes**: `GET/PUT /api/campaigns/:id/evidence`, `POST /api/campaigns/:id/evidence/files?visibility=`, `GET/DELETE /api/campaigns/:id/evidence/files/:fileId`, `POST/DELETE /api/campaigns/:id/evidence/seal`, public `GET /api/evidence/:bundleId/manifest`.
- **Guards so KYB housekeeping never touches evidence**: `POST /api/files/kyb` accepts KYB kinds only and does not count evidence files as unattached; `DELETE /api/files/kyb/:id` ignores evidence files; `files:sweep` skips `EVIDENCE` in the 24 h unattached rule; `eraseUser` keeps evidence files (campaign record, ADR-047).
- 8 new campaign error codes with English messages.

### Files changed
- `packages/db/src/schema/{enums,campaigns}.ts`, `packages/db/drizzle/0008_noisy_tinkerer.sql` + snapshot/journal — schema.
- `packages/db/src/gdpr.ts` — erasure skips evidence files.
- `packages/shared/src/organizations.ts` — comment (KYB kinds = enum minus EVIDENCE).
- `apps/web/src/lib/campaigns/evidence.ts` (new), `errors.ts`, `route.ts` — logic, codes, mapping.
- `apps/web/src/app/api/campaigns/[id]/evidence/**`, `apps/web/src/app/api/evidence/[bundleId]/manifest/route.ts` (new) — routes.
- `apps/web/src/app/api/files/kyb/route.ts`, `[id]/route.ts`, `apps/web/src/lib/files/sweep.ts` — guards.
- `apps/web/messages/en.json` — error texts.
- Tests: `evidence.test.ts`, `evidence-db.test.ts` (new); `helpers/organizations.ts` (cleanup of evidence rows), `organizations-api.test.ts` (enum equality minus EVIDENCE), `packages/db/src/__tests__/integration.test.ts` (22 tables, erasure keeps an evidence file).
- Docs: ADR-047, `docs/technical/01`, `03`, `04` (API rows; also flips "My donations" to Live on dev, PR #79), `06`, `09`; this file; spec §033c decision line.

### Deviations from the task (and why)
- The existing `evidence_bundles.private_file_keys[]`, `public_cids[]` and `status` columns stay unused: files need per-file hash, size, type and visibility (new `evidence_files` table), and "on chain" is read from the indexer (`chain.vote_round`), which is the source of truth for chain state (manifest §6). Dropping the columns would break backward compatibility with the deployed code.
- Public evidence files go to the public bucket (ADR-037), not IPFS/PollinationX (postponed in ADR-037).
- No UI yet (parts 2–3).

### New dependencies
- none

### How to verify
1. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev`; Postgres + S3 stand-in running; `pnpm --filter @cherrio/db migrate`.
2. `cd apps/web && npx vitest run src/__tests__/evidence.test.ts src/__tests__/evidence-db.test.ts` → 12 passed.
3. `pnpm --filter @cherrio/db test:integration` → 16 passed; then `migrate` again.

### Test results (this session, 2026-10-04)
```
 ✓ src/__tests__/evidence-db.test.ts (6 tests) 702ms
 ✓ src/__tests__/evidence.test.ts (6 tests) 4ms
 Test Files  2 passed (2)
      Tests  12 passed (12)
```
Full web suite: `Test Files  44 passed (44)` / `Tests  402 passed (402)` (390 before).
DB integration: `Tests  16 passed (16)`. `pnpm check:design`: "Design check passed — no violations found." Lint and typecheck (all packages except contracts): no errors.

Deliberate breaks (each restored afterwards):
- `files:sweep` without the `EVIDENCE` guard → `× … KYB housekeeping leaves evidence files alone` — `Tests  1 failed | 11 passed (12)`.
- public view trusting any sealed hash (`onChain: hash !== null`) → `× the full draft → seal → chain flow` and `× a different hash on chain: the stored bundle is not shown` — `Tests  2 failed | 10 passed (12)`.
- manifest without file ordering → `× is exact …` and `× does not depend on upload order` — `Tests  2 failed | 10 passed (12)`.
- `eraseUser` without the `EVIDENCE` guard → `× eraseUser … marks the right files deleted` — `AssertionError: expected [ …(4) ] to deeply equal [ …(3) ]`, `Tests  1 failed | 15 passed (16)`.

E2E, build: NOT RUN — no UI change in part 1 (CI runs them).

### Open questions / risks
- A public evidence PDF is stored unchanged (personal data in its content or metadata is the fundraiser's responsibility, as for ADR-039 PDFs); the dashboard (part 2) will warn clearly and steer invoices to "private".
- The note is public once on chain; the dashboard will say so next to the field.

### Suggested commit message
feat(evidence): milestone evidence bundles, canonical manifest and API (TASK-033c part 1)

## Part 2 — fundraiser dashboard (branch `feat/TASK-033c-evidence-dashboard`)

### What I implemented
- `/[locale]/account/campaigns/[id]` once `DEPLOYED`: the lifecycle panel (state, "Finish the campaign" / "Pay out" / "Count the votes" — the component of the campaign page, so the fundraiser can trigger them, ADR-045 §4) and **"Evidence for donors"** (`EvidenceManager.tsx`): public note, up to 10 files with a Private/Public choice and plain-language warnings, download (private, audited route) / open (public) / remove, **Seal and submit to the blockchain** (seal API → `submitEvidence(bundleHash)` from the payout wallet, simulated through `/api/rpc`), "Reopen to make changes", and "Submitted evidence" per round with "On the blockchain" and the fingerprint. Without the payout wallet connected the button stays disabled with "Connect the campaign's payout wallet (0x…)".
- `sendLifecycle` + `{ kind: "submitEvidence", bundleHash }`; reverts `NotBeneficiary` → `not_beneficiary`, `NotPaying` → `already_done` (+ message).
- E2E wallet helper extracted to `e2e/helpers/wallet.ts` (shared by lifecycle and evidence specs); `deleteTestUser` removes evidence rows first.
- Fundraisers guide: "Submitting evidence" section; vote window and quorum corrected to ADR-045 (7 days, 25 %; the guide still said 24 h / 50 %).

### Test results (this session, 2026-10-04)
- `pnpm --filter web test`: `Test Files  44 passed (44)` / `Tests  402 passed (402)` (the new `submitEvidence` cases are inside existing table-driven tests).
- `CI=1 pnpm exec playwright test e2e/evidence.spec.ts e2e/lifecycle.spec.ts --retries=0` (after `pnpm build`): `12 passed (27.3s)` — 2 evidence + 4 lifecycle tests × 2 viewports.
- Lint, typecheck: no errors. `pnpm check:design`: "Design check passed — no violations found."
- Deliberate break: `submitEvidence` sending a fixed zero hash →
  - unit: `× sendLifecycle > simulates from the donating address, then sends each action with its arguments` — `Tests  1 failed | 5 passed (6)`;
  - E2E (rebuilt): `1) [chromium-390] › e2e/evidence.spec.ts:80:3 › … the payout wallet submits its fingerprint` — expected `"0x1a120b7b…2928049"`, received `"0x0000…0000"`; `1 failed, 1 passed`. Restored.

### Deviations
- The dashboard reuses `LifecyclePanel` for the due actions instead of a separate fundraiser panel (same rules, one component).
