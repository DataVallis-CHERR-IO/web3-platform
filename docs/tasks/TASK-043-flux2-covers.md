# TASK-043 — FLUX.2 [pro] for demo covers, chosen by the admin

Source: David, 2026-10-05 10:11: "dodaš še flux.2 pro model za generiranje slik, ker je cenejši kot nano banana pro, pa oba obdrži in daj adminu na izbiro kateri model se uporabi." Amends ADR-052 §4.

## Scope
- Model registry `apps/web/src/lib/demo/cover-models.ts`: `flux-2-pro` (`fal-ai/flux-2-pro`, `image_size: landscape_4_3`, `output_format: jpeg`) and `nano-banana-pro` (unchanged fields); FLUX.2 [pro] is the default; unknown names fall back to it (an admin request cannot pick an arbitrary fal endpoint).
- Start and check routes take `model`; the queue URL follows the model; the audit row records the endpoint.
- Admin → Demo campaigns: "Cover images" radio choice in the creation form and above "Generate N missing covers"; the progress line names the model.
- Owner guide §8 (v1.6).

## Not in scope
Remembering the choice between visits; other models; per-campaign regeneration.

## Tests
Unit/DB tests with the fake fal for both models (URLs, request fields, check URL, audit), model parsing, the browser loop sending the model; deliberate break (check uses the default model's queue); admin-demo E2E checks the choice and the default.
