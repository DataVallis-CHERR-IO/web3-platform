"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { CAMPAIGN_MEDIA_LIMITS } from "@cherrio/shared";
import { Button, Field, FileField } from "@cherrio/ui";
import { useRouter } from "@/i18n/routing";
import type { MediaView } from "@/lib/campaigns/media-view";

/**
 * Gallery images, video links and public PDFs of a campaign (ADR-039). Shown in
 * every campaign status: media is not on-chain, so it can change at any time.
 * Everything is public as soon as it is added.
 */
export function CampaignMediaManager({ campaignId, media }: { campaignId: string; media: MediaView }) {
  const t = useTranslations("campaigns.media");
  const tErrors = useTranslations("campaigns.errors");
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<{ section: string; text: string } | null>(null);
  const [videoUrl, setVideoUrl] = React.useState("");
  const [picker, setPicker] = React.useState(0); // remounts the file pickers after an upload

  const errorText = (code?: string) => (code && tErrors.has(code as never) ? tErrors(code as never) : t("failed"));

  async function run(section: string, request: () => Promise<Response>) {
    setBusy(section);
    setError(null);
    try {
      const res = await request();
      if (res.ok) {
        router.refresh();
        return true;
      }
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setError({ section, text: errorText(json.error) });
    } catch {
      setError({ section, text: t("failed") });
    } finally {
      setBusy(null);
      setPicker((n) => n + 1);
    }
    return false;
  }

  const upload = (section: "images" | "documents", file: File) => {
    const body = new FormData();
    body.set("file", file);
    return run(section, () => fetch(`/api/campaigns/${campaignId}/media/${section}`, { method: "POST", body }));
  };
  const remove = (section: string, mediaId: string) =>
    run(section, () => fetch(`/api/campaigns/${campaignId}/media/${mediaId}`, { method: "DELETE" }));

  const alert = (section: string) =>
    error?.section === section && (
      <p role="alert" className="p-3 border-2 border-[var(--ink)] bg-[var(--surface)] text-sm font-bold text-[var(--ink)]">
        {error.text}
      </p>
    );
  const heading = "text-lg font-display uppercase text-[var(--ink)]";

  return (
    <section className="ch-panel p-6 md:p-8 flex flex-col gap-8" aria-labelledby="campaign-media-title">
      <div className="flex flex-col gap-2">
        <h2 id="campaign-media-title" className="text-xl font-display uppercase text-[var(--ink)]">
          {t("title")}
        </h2>
        <p className="text-sm text-[var(--ink)]">{t("publicNote")}</p>
      </div>

      {/* Gallery */}
      <div className="flex flex-col gap-3">
        <h3 className={heading}>{t("gallery", { count: media.images.length, max: CAMPAIGN_MEDIA_LIMITS.gallery })}</h3>
        {media.images.length > 0 && (
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3" aria-label={t("galleryList")}>
            {media.images.map((image, index) => (
              <li key={image.id} className="flex flex-col gap-2">
                {/* A plain <img>: the file is served by the public media bucket, not by Next. */}
                <img src={image.url} alt={t("imageAlt", { n: index + 1 })} className="w-full aspect-[4/3] object-cover border-2 border-[var(--ink)]" />
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  aria-label={`${t("remove")}: ${t("imageAlt", { n: index + 1 })}`}
                  onClick={() => remove("images", image.id)}
                >
                  {t("remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {media.images.length < CAMPAIGN_MEDIA_LIMITS.gallery && (
          <FileField
            key={`img-${picker}`}
            label={t("addImage")}
            hint={t("imageHint")}
            accept=".jpg,.jpeg,.png,.webp"
            busy={busy === "images"}
            fileLabel={busy === "images" ? t("uploading") : undefined}
            removeLabel={t("remove")}
            onSelect={(file) => void upload("images", file)}
            onRemove={() => undefined}
          />
        )}
        {alert("images")}
      </div>

      {/* Videos */}
      <div className="flex flex-col gap-3">
        <h3 className={heading}>{t("videos", { count: media.videos.length, max: CAMPAIGN_MEDIA_LIMITS.video })}</h3>
        {media.videos.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label={t("videoList")}>
            {media.videos.map((video) => (
              <li key={video.id} className="flex flex-wrap items-center gap-3">
                <a href={video.url} target="_blank" rel="noreferrer" className="ch-mono text-sm underline break-all text-[var(--ink)]">
                  {video.url}
                </a>
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  aria-label={`${t("remove")}: ${video.url}`}
                  onClick={() => remove("videos", video.id)}
                >
                  {t("remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {media.videos.length < CAMPAIGN_MEDIA_LIMITS.video && (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const ok = await run("videos", () =>
                fetch(`/api/campaigns/${campaignId}/media/videos`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ url: videoUrl }),
                })
              );
              if (ok) setVideoUrl("");
            }}
          >
            <Field
              id="campaign-video-url"
              label={t("addVideo")}
              hint={t("videoHint")}
              type="url"
              inputMode="url"
              value={videoUrl}
              onChange={(event) => setVideoUrl(event.target.value)}
              autoComplete="off"
            />
            <div>
              <Button type="submit" disabled={busy !== null || videoUrl.trim() === ""}>
                {busy === "videos" ? t("saving") : t("addVideoButton")}
              </Button>
            </div>
          </form>
        )}
        {alert("videos")}
      </div>

      {/* Documents */}
      <div className="flex flex-col gap-3">
        <h3 className={heading}>{t("documents", { count: media.documents.length, max: CAMPAIGN_MEDIA_LIMITS.document })}</h3>
        {media.documents.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label={t("documentList")}>
            {media.documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center gap-3">
                <a href={doc.url} target="_blank" rel="noreferrer" className="text-sm font-bold underline break-all text-[var(--ink)]">
                  {doc.label}
                </a>
                <span className="text-xs text-[var(--ink-muted)]">{t("sizeKb", { size: doc.sizeKb })}</span>
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  aria-label={`${t("remove")}: ${doc.label}`}
                  onClick={() => remove("documents", doc.id)}
                >
                  {t("remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {media.documents.length < CAMPAIGN_MEDIA_LIMITS.document && (
          <FileField
            key={`doc-${picker}`}
            label={t("addDocument")}
            hint={t("documentHint")}
            accept=".pdf,application/pdf"
            busy={busy === "documents"}
            fileLabel={busy === "documents" ? t("uploading") : undefined}
            removeLabel={t("remove")}
            onSelect={(file) => void upload("documents", file)}
            onRemove={() => undefined}
          />
        )}
        {alert("documents")}
      </div>
    </section>
  );
}
