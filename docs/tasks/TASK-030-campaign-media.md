# TASK-030 — Campaign media: gallery, video links, public PDFs (ADR-039)

Branch: `feat/TASK-030-campaign-media` (from `dev`). Depends on: TASK-010 (campaigns, cover pipeline, public bucket ADR-037), TASK-029 (admin pages).
Decisions: ADR-039 (David, 2026-10-03). Model: standard.

## Goal
An `ORG_ADMIN` of a verified organisation adds and removes media of a campaign at any time:
- **Gallery:** up to 10 images;
- **Videos:** up to 3 YouTube or Vimeo links;
- **Documents:** up to 5 public PDFs of at most 20 MB.

There is no review, and everything is public immediately. A platform admin sees all media on the campaign's admin page and can remove any item (takedown). Public campaign pages (TASK-011) will show the media; this task stores and manages it.

## Why editing after go-live is safe
The Campaign contract stores `offchainId`, beneficiary, target, deadline and beneficiary type — nothing about media (`CampaignFactory.CreateParams`, technical 02 §2). Adding or removing media changes only rows in `app.campaign_media` and objects in the public bucket. No transaction is needed, and the on-chain campaign is unaffected.

## Scope

### Data (backward-compatible migration 0005)
- `media_kind`: add `DOCUMENT`.
- `storage_provider`: add `EXTERNAL` (a video link: `cid` = `youtube:<id>` or `vimeo:<id>`).
- `campaign_media`: add `label` (text, the PDF's display name), `size_bytes` (integer), `created_by` (→ users).

### Shared (`@cherrio/shared`)
- `CAMPAIGN_MEDIA_LIMITS` — `gallery 10`, `video 3`, `document 5`, `documentBytes 20 MB`.
- `parseVideoUrl(url)`. Accepts:
  - `youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/shorts/ID`, `youtube.com/embed/ID` (ID = 11 characters of `[A-Za-z0-9_-]`);
  - `vimeo.com/NUMBER`, `player.vimeo.com/video/NUMBER`.

  Anything else is refused. Returns `{ provider, id }`.
- `videoEmbedUrl(provider, id)` → `https://www.youtube-nocookie.com/embed/ID` or `https://player.vimeo.com/video/ID?dnt=1`.
- `videoWatchUrl(provider, id)` — the link for people.
- `pdfLabel(filename)` — a display name: no path, no control characters, at most 120 characters, ending in `.pdf`.

### API (`ORG_ADMIN` of an APPROVED organisation; anyone else 404; origin check; 30 requests/min per user)
- `POST /api/campaigns/:id/media/images` — multipart `file`; cover pipeline (WebP, no metadata); key `campaigns/<id>/g-<random>.webp`.
- `POST /api/campaigns/:id/media/videos` — JSON `{ url }`.
- `POST /api/campaigns/:id/media/documents` — multipart `file`:
  - must start with `%PDF-` and be at most 20 MB;
  - stored unchanged under key `campaigns/<id>/d-<random>.pdf`, with `Content-Type: application/pdf` and `Content-Disposition: inline; filename="document.pdf"`;
  - the label comes from the original file name.
- `DELETE /api/campaigns/:id/media/:mediaId` — removes the item (not the cover) and deletes its object.
- `DELETE /api/admin/campaigns/:id/media/:mediaId` — `PLATFORM_ADMIN` (404 otherwise): takedown of any item except the cover.
- **Rules for these routes:**
  - Limits are checked under a per-campaign lock: `too_many_images`, `too_many_videos`, `too_many_documents`.
  - Allowed in every status.
  - Each change is audited (`campaign.media_add`, `campaign.media_remove`, `campaign.media_takedown`) with kind and media id only.
  - Error codes come from `campaigns.errors.*`.

### Pages
- `/en/account/campaigns/[id]`: a **Media** section in every status, with:
  - a gallery with thumbnails and Remove;
  - "Add a video link";
  - documents with links and Remove.

  The form warns that everything is public at once and must not contain personal data of other people; PDFs keep their own metadata (author, …).
- `/en/admin/campaigns/[id]`: a **Media** section listing the gallery, videos (links) and documents, each with **Remove** (confirmation dialog), labelled as takedown.

### Tests (must be able to fail)
- Unit: `parseVideoUrl` (all accepted forms; hostile and look-alike URLs refused), `pdfLabel`.
- Integration (Postgres + local S3):
  - add image, video and PDF to a DRAFT and to a DEPLOYED campaign;
  - the 11th image / 4th video / 6th PDF is refused;
  - HTML renamed `.pdf` is refused;
  - a PDF over 20 MB is refused;
  - a stranger gets 404;
  - remove deletes the object (URL then 404);
  - the cover cannot be removed through this route;
  - admin takedown is audited; a non-admin takedown is 404.
- E2E: an organisation adds one image, one video link and one PDF; an admin removes the PDF; axe on both pages.
- Deliberate breaks: the image limit, and the `%PDF-` check.

### Docs
- `docs/technical/01` (lifecycle note), `03` (columns, enums), `04` (routes, pages), `05` (public bucket now also holds PDFs), `06` (unreviewed public content, separate origin, takedown), `07`, `08` (takedown runbook), `09`;
- `docs/guides/fundraisers.md` (how to add media);
- `next.config.mjs` body limit for 20 MB uploads.

## Must not touch
Contracts, indexer, private-file code, the cover rules (cover stays fixed after submit).
