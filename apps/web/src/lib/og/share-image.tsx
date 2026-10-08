import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { tokenColor } from "@cherrio/ui/lib/tokens";

// Link preview images (TASK-055b; static campaign design TASK-059): what X,
// Facebook, LinkedIn, WhatsApp and Telegram show for a shared link. Rendered by next/og (Satori) — flexbox only,
// fonts as files, no WebP: the cover is converted to JPEG here.
//
// Colours are the design tokens (light theme), read from tokens.json: Satori cannot use CSS variables.

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

const C = {
  cherry: tokenColor("accent"),
  ink: tokenColor("ink"),
  muted: tokenColor("ink-muted"),
  surface: tokenColor("surface"),
  sunken: tokenColor("surface-sunken"),
  white: tokenColor("white"),
  mist: tokenColor("mist-300"),
  slate: tokenColor("slate-500"),
} as const;

const COVER_WIDTH = 500;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const COVER_TIMEOUT_MS = 4000;

type Font = { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" };

const FONT_FILES: [name: string, file: string, weight: 400 | 700][] = [
  ["Archivo Black", "archivo-black-latin-400-normal.woff", 400],
  ["Archivo Black Ext", "archivo-black-latin-ext-400-normal.woff", 400],
  ["Archivo", "archivo-latin-400-normal.woff", 400],
  ["Archivo Ext", "archivo-latin-ext-400-normal.woff", 400],
  ["Archivo", "archivo-latin-700-normal.woff", 700],
  ["Archivo Ext", "archivo-latin-ext-700-normal.woff", 700],
];

// Satori picks one font per family and weight; the Latin Extended files (č, š,
// ž, …) are separate families listed second, so missing glyphs fall back to them.
const DISPLAY = "Archivo Black, Archivo Black Ext";
const SANS = "Archivo, Archivo Ext";

let fontsPromise: Promise<Font[]> | null = null;

/**
 * The fonts from `public/fonts` (OFL). `next start` runs in apps/web; the Docker
 * image runs `node apps/web/server.js` from /app — both places are tried.
 */
export function loadOgFonts(): Promise<Font[]> {
  fontsPromise ??= Promise.all(
    FONT_FILES.map(async ([name, file, weight]) => {
      const bytes = await readFirst([join(process.cwd(), "public/fonts", file), join(process.cwd(), "apps/web/public/fonts", file)]);
      return { name, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, weight, style: "normal" as const };
    })
  ).catch((e) => {
    fontsPromise = null; // try again on the next request
    throw e;
  });
  return fontsPromise;
}

async function readFirst(paths: string[]): Promise<Buffer> {
  let last: unknown;
  for (const p of paths) {
    try {
      return await readFile(p);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** The cover as a JPEG data URI sized for the left column, or null (missing, slow, too big, not an image). */
export async function coverDataUri(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(COVER_TIMEOUT_MS) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return null;
    const jpeg = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .resize(COVER_WIDTH, OG_SIZE.height, { fit: "cover" })
      .jpeg({ quality: 82 })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Long titles are cut at a word boundary so three lines always fit. */
export function clampTitle(title: string, max = 80): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The preview's state (TASK-059, David 2026-10-08): a preview is static — the
 * networks cache it at the moment of sharing, so live figures would go stale
 * there. It changes only when the campaign's outcome is known.
 */
export type CampaignOgVariant = "live" | "funded" | "ended";

/** Public state → preview variant: succeeded (and everything after it) = funded; failed/rejected = ended. */
export function ogVariant(state: string | null | undefined): CampaignOgVariant {
  if (state === "succeeded" || state === "voting" || state === "completed" || state === "frozen" || state === "needs-review") return "funded";
  if (state === "failed" || state === "rejected") return "ended";
  return "live";
}

export interface CampaignOgData {
  variant: CampaignOgVariant;
  title: string;
  /** Organisation name, or null (campaign of an individual). */
  org: string | null;
  orgVerified: boolean;
  /** "Education · Slovenia" */
  tag: string;
  /** "Goal €10,000" — in the campaign's goal currency, never USDC. */
  goal: string;
  /** "Until 20 Oct 2026" */
  until: string;
  cover: string | null;
  logo: string;
  labels: { verified: string; successLine: string; publicLine: string; donate: string; funded: string; ended: string };
}

const Check = ({ color }: { color: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" style={{ marginRight: 10 }}>
    <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" fill={color} />
  </svg>
);

/** The CHERR.IO wordmark (white) as a data URI, read once from `public/brand`. */
let logoPromise: Promise<string> | null = null;
export function loadOgLogo(): Promise<string> {
  logoPromise ??= readFirst([
    join(process.cwd(), "public/brand/cherrio-wordmark-white.svg"),
    join(process.cwd(), "apps/web/public/brand/cherrio-wordmark-white.svg"),
  ])
    .then((b) => `data:image/svg+xml;base64,${b.toString("base64")}`)
    .catch((e) => {
      logoPromise = null;
      throw e;
    });
  return logoPromise;
}

/**
 * Campaign preview (design "S2", David 2026-10-08): cover left; dark panel with
 * the logo, cause and country, organisation, title, goal and end date, an empty
 * goal track with the 10 % success line (true for every campaign — no fake
 * progress), and the Donate button. Funded / ended campaigns show a banner instead.
 */
export function CampaignOgImage(d: CampaignOgData) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", background: C.ink, fontFamily: SANS }}>
      {d.cover ? (
        <img src={d.cover} width={COVER_WIDTH} height={OG_SIZE.height} alt="" style={{ objectFit: "cover" }} />
      ) : (
        <div style={{ width: COVER_WIDTH, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.slate }}>
          <img src={d.logo} width={280} height={107} alt="" />
        </div>
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "40px 48px", borderTop: `12px solid ${C.cherry}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <img src={d.logo} width={168} height={64} alt="" />
          <div style={{ display: "flex", padding: "6px 14px", border: `3px solid ${C.mist}`, color: C.white, fontSize: 20, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
            {d.tag}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {d.org && (
            <div style={{ display: "flex", alignItems: "center", fontSize: 22, color: C.mist, marginBottom: 10 }}>
              {d.orgVerified && <Check color={C.cherry} />}
              {d.orgVerified ? `${d.org} · ${d.labels.verified}` : d.org}
            </div>
          )}
          <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: 46, lineHeight: 1.08, color: C.white }}>{d.title}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <span style={{ fontFamily: DISPLAY, fontSize: 38, color: C.cherry }}>{d.goal}</span>
            <span style={{ fontSize: 22, color: C.mist }}>{d.until}</span>
          </div>
          {d.variant === "live" ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", position: "relative", height: 26, border: `4px solid ${C.white}` }}>
                <div style={{ display: "flex", position: "absolute", left: "10%", top: -14, width: 6, height: 46, background: C.cherry }} />
              </div>
              <div style={{ display: "flex", marginTop: 10, marginLeft: "6%", fontSize: 19, color: C.mist }}>{d.labels.successLine}</div>
            </div>
          ) : (
            <div style={{ display: "flex", alignSelf: "flex-start", padding: "8px 16px", background: d.variant === "funded" ? C.cherry : C.mist, color: C.ink, fontFamily: DISPLAY, fontSize: 26, textTransform: "uppercase" }}>
              {d.variant === "funded" ? d.labels.funded : d.labels.ended}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", marginTop: 18 }}>
            <span style={{ display: "flex", alignItems: "center", fontSize: 21, color: C.white, fontWeight: 700 }}>
              <Check color={C.white} />
              {d.labels.publicLine}
            </span>
            {d.variant === "live" && (
              <div style={{ display: "flex", marginLeft: "auto", alignItems: "center", padding: "12px 22px", background: C.cherry, color: C.ink, fontFamily: DISPLAY, fontSize: 24, textTransform: "uppercase" }}>
                {d.labels.donate}
                <svg width="26" height="26" viewBox="0 0 24 24" style={{ marginLeft: 10 }}>
                  <path d="M3 11h13.2l-5.6-5.6L12 4l8 8-8 8-1.4-1.4 5.6-5.6H3z" fill={C.ink} />
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The default preview of every other page: same dark brand panel as the campaign preview. */
export function SiteOgImage({ headline, sub, host, logo }: { headline: string; sub: string; host: string; logo: string }) {
  return (
    <div
      style={{
        width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
        background: C.ink, borderTop: `14px solid ${C.cherry}`, padding: "64px 80px", fontFamily: SANS, color: C.white,
      }}
    >
      <img src={logo} width={260} height={99} alt="" />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: 82, lineHeight: 1.0, letterSpacing: -2 }}>{headline}</div>
        <div style={{ display: "flex", marginTop: 28, fontSize: 34, color: C.mist }}>{sub}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 28, fontWeight: 700 }}>
        <div style={{ display: "flex", width: 160, height: 18, background: C.cherry }} />
        <span>{host}</span>
      </div>
    </div>
  );
}
