import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { formatUsdc } from "@cherrio/shared/money";
import { tokenColor } from "@cherrio/ui/lib/tokens";

// Link preview images (TASK-055b): what X, Facebook, LinkedIn, WhatsApp and
// Telegram show for a shared link. Rendered by next/og (Satori) — flexbox only,
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
  white: tokenColor("surface-raised"),
} as const;

const COVER_WIDTH = 520;
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

export interface CampaignOgData {
  title: string;
  raisedUsdc: bigint;
  /** Fill of the bar, 0–100 (whole percent). */
  percent: number;
  targetEurCents: bigint;
  cover: string | null;
  host: string;
  labels: { raised: string; of: string; cta: string };
}

const eur = (cents: bigint) =>
  new Intl.NumberFormat("en", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Number(cents / 100n));

function Wordmark({ size = 34, color = C.ink }: { size?: number; color?: string }) {
  return (
    <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: size, color, letterSpacing: -0.5 }}>
      CHERR.IO
    </div>
  );
}

export function CampaignOgImage(d: CampaignOgData) {
  const fill = Math.max(0, Math.min(100, d.percent));
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", background: C.surface, fontFamily: SANS, color: C.ink }}>
      {d.cover ? (
        <img src={d.cover} width={COVER_WIDTH} height={OG_SIZE.height} alt="" style={{ objectFit: "cover" }} />
      ) : (
        <div style={{ width: COVER_WIDTH, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.sunken }}>
          <Wordmark size={64} color={C.muted} />
        </div>
      )}
      <div
        style={{
          flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between",
          borderLeft: `8px solid ${C.ink}`, borderTop: `10px solid ${C.cherry}`, padding: "44px 52px 44px 52px", background: C.white,
        }}
      >
        <Wordmark />
        <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: 50, lineHeight: 1.08, letterSpacing: -1 }}>{d.title}</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "baseline" }}>
            <span style={{ fontFamily: DISPLAY, fontSize: 44, color: C.ink }}>{`${formatUsdc(d.raisedUsdc, { maxDecimals: 0, minDecimals: 0 })} USDC`}</span>
            <span style={{ fontSize: 26, color: C.muted, marginLeft: 14 }}>{`${d.labels.raised} ${d.labels.of} ${eur(d.targetEurCents)}`}</span>
          </div>
          <div style={{ display: "flex", marginTop: 18, height: 30, border: `4px solid ${C.ink}`, background: C.surface }}>
            <div style={{ display: "flex", width: `${fill}%`, height: "100%", background: C.cherry }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 18, fontSize: 26, fontWeight: 700 }}>
            <span>{`${d.percent}%`}</span>
            <span style={{ color: C.muted }}>{`${d.labels.cta} · ${d.host}`}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SiteOgImage({ headline, sub, host }: { headline: string; sub: string; host: string }) {
  return (
    <div
      style={{
        width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
        background: C.white, borderTop: `14px solid ${C.cherry}`, padding: "64px 80px", fontFamily: SANS, color: C.ink,
      }}
    >
      <Wordmark size={56} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: 82, lineHeight: 1.0, letterSpacing: -2 }}>{headline}</div>
        <div style={{ display: "flex", marginTop: 28, fontSize: 34, color: C.muted }}>{sub}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 28, fontWeight: 700 }}>
        <div style={{ display: "flex", width: 160, height: 18, background: C.cherry }} />
        <span>{host}</span>
      </div>
    </div>
  );
}
