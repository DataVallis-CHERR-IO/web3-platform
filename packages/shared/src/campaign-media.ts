// Campaign media (ADR-039): limits, video links and PDF display names.
// Shared by the API (validation) and the pages (forms, embeds).

export const CAMPAIGN_MEDIA_LIMITS = {
  gallery: 10,
  video: 3,
  document: 5,
  /** Bytes of one public PDF. */
  documentBytes: 20 * 1024 * 1024,
} as const;

export type VideoProvider = "youtube" | "vimeo";
export interface VideoRef {
  provider: VideoProvider;
  id: string;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,12}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);

/**
 * A YouTube or Vimeo video from a link someone pasted, or null.
 * Only exact hosts over https are accepted (no look-alike domains, no other sites).
 */
// `shared` is compiled without DOM or Node types; URL exists in every runtime we use
// (Node 22, browsers, edge), so declare only the part we read.
type ParsedUrl = {
  protocol: string;
  username: string;
  password: string;
  port: string;
  hostname: string;
  pathname: string;
  searchParams: { get(name: string): string | null };
};
const UrlCtor = (globalThis as unknown as { URL: new (input: string) => ParsedUrl }).URL;

export function parseVideoUrl(input: string): VideoRef | null {
  let url: ParsedUrl;
  try {
    url = new UrlCtor(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "youtu.be") {
    const id = parts[0] ?? "";
    return parts.length === 1 && YOUTUBE_ID.test(id) ? { provider: "youtube", id } : null;
  }
  if (YOUTUBE_HOSTS.has(host)) {
    const id =
      parts.length === 1 && parts[0] === "watch"
        ? url.searchParams.get("v") ?? ""
        : parts.length === 2 && ["shorts", "embed", "live"].includes(parts[0]!)
          ? parts[1]!
          : "";
    return YOUTUBE_ID.test(id) ? { provider: "youtube", id } : null;
  }
  if (VIMEO_HOSTS.has(host)) {
    const id = host === "player.vimeo.com" ? (parts[0] === "video" && parts.length === 2 ? parts[1]! : "") : parts.length === 1 ? parts[0]! : "";
    return VIMEO_ID.test(id) ? { provider: "vimeo", id } : null;
  }
  return null;
}

/** `campaign_media.cid` of a video: `youtube:<id>` or `vimeo:<id>`. */
export const videoCid = (video: VideoRef) => `${video.provider}:${video.id}`;

export function videoFromCid(cid: string): VideoRef | null {
  const [provider, id = ""] = cid.split(":");
  if (provider === "youtube" && YOUTUBE_ID.test(id)) return { provider, id };
  if (provider === "vimeo" && VIMEO_ID.test(id)) return { provider, id };
  return null;
}

/** The player to embed: YouTube's privacy-enhanced mode, Vimeo with "do not track". */
export function videoEmbedUrl(video: VideoRef): string {
  return video.provider === "youtube"
    ? `https://www.youtube-nocookie.com/embed/${video.id}`
    : `https://player.vimeo.com/video/${video.id}?dnt=1`;
}

/** The video's own page, for a plain link. */
export function videoWatchUrl(video: VideoRef): string {
  return video.provider === "youtube" ? `https://www.youtube.com/watch?v=${video.id}` : `https://vimeo.com/${video.id}`;
}

/**
 * Display name of an uploaded PDF from its file name: no folders, no control
 * characters, at most 120 characters, always ending in ".pdf".
 */
export function pdfLabel(filename: string): string {
  const base = (filename.split(/[\\/]/).pop() ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.pdf$/i, "");
  const name = (base || "document").slice(0, 116).trim();
  return `${name}.pdf`;
}
