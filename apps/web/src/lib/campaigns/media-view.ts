import { videoFromCid, videoWatchUrl, type VideoProvider } from "@cherrio/shared";
import { publicMediaUrl } from "@/lib/media/public-store";
import type { listMedia } from "./media";

// What the pages need to show the media of a campaign (ADR-039), built on the
// server so the client never sees storage keys or the bucket configuration.

export interface MediaView {
  images: { id: string; url: string }[];
  videos: { id: string; provider: VideoProvider; url: string }[];
  documents: { id: string; url: string; label: string; sizeKb: number }[];
}

export function toMediaView(rows: Awaited<ReturnType<typeof listMedia>>): MediaView {
  const view: MediaView = { images: [], videos: [], documents: [] };
  for (const row of rows) {
    if (row.kind === "GALLERY") view.images.push({ id: row.id, url: publicMediaUrl(row.cid) });
    else if (row.kind === "DOCUMENT")
      view.documents.push({
        id: row.id,
        url: publicMediaUrl(row.cid),
        label: row.label ?? "document.pdf",
        sizeKb: Math.ceil((row.sizeBytes ?? 0) / 1024),
      });
    else if (row.kind === "VIDEO") {
      const video = videoFromCid(row.cid);
      if (video) view.videos.push({ id: row.id, provider: video.provider, url: videoWatchUrl(video) });
    }
  }
  return view;
}
