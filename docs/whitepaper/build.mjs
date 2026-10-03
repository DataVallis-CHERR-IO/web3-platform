// Builds the CHERR.IO whitepaper PDF from whitepaper.md.
//
//   npm install          (once)
//   npm run build        -> dist/<filename from front matter>.pdf
//   npm run html         -> build/whitepaper.html only (open it in Chrome to preview)
//
// Pipeline: whitepaper.md (+ front matter) -> markdown-it -> sections + TOC
// -> template/whitepaper.html + template/style.css (fonts, logos and diagrams inlined)
// -> Paged.js in headless Chromium -> PDF.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import attrs from "markdown-it-attrs";
import container from "markdown-it-container";

const here = dirname(fileURLToPath(import.meta.url));
const htmlOnly = process.argv.includes("--html-only");

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function dataUri(path, mime) {
  return `data:${mime};base64,${(await readFile(path)).toString("base64")}`;
}

// ---------- markdown ----------
const { data: meta, content } = matter(await readFile(join(here, "whitepaper.md"), "utf8"));
for (const key of ["title", "headline", "version", "date", "publisher", "website", "filename"]) {
  if (!meta[key]) throw new Error(`whitepaper.md front matter is missing "${key}"`);
}

const md = new MarkdownIt({ html: true, typographer: true, linkify: false });
md.use(attrs);

// ::: stats  — a list whose items start with **number**
md.use(container, "stats", {
  render: (tokens, i) => (tokens[i].nesting === 1 ? '<div class="stats">\n' : "</div>\n"),
});
// ::: note Optional title
md.use(container, "note", {
  render: (tokens, i) => {
    if (tokens[i].nesting !== 1) return "</div></aside>\n";
    const title = tokens[i].info.trim().replace(/^note\s*/, "") || "Note";
    return `<aside class="note"><div class="note-label">${escapeHtml(title)}</div><div class="note-body">\n`;
  },
});

// Local SVG diagrams are inlined so they use the document fonts.
const svgCache = new Map();
const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet("src");
  if (src && src.endsWith(".svg") && !/^https?:/.test(src) && svgCache.has(src)) {
    const alt = escapeHtml(token.content);
    return `<figure class="diagram" aria-label="${alt}">${svgCache.get(src)}</figure>`;
  }
  return defaultImage(tokens, idx, options, env, self);
};
for (const m of content.matchAll(/!\[[^\]]*\]\(([^)]+\.svg)\)/g)) {
  const svg = await readFile(resolve(here, m[1]), "utf8");
  svgCache.set(m[1], svg.replace(/<\?xml[^>]*>/, ""));
}

// A paragraph that holds only a figure must not be wrapped in <p>.
let body = md.render(content).replace(/<p>\s*(<figure[\s\S]*?<\/figure>)\s*<\/p>/g, "$1");

// ---------- sections + TOC ----------
// Split on <h1>/<h2>: each becomes its own <section>, starting on a new page.
const parts = body.split(/(?=<h[12][\s>])/);
const toc = [];
let abstract = "";
const sections = [];
for (const part of parts) {
  const head = part.match(/^<h([12])([^>]*)>([\s\S]*?)<\/h\1>/);
  if (!head) {
    if (part.trim()) sections.push(`<section class="loose">${part}</section>`);
    continue;
  }
  const [whole, level, attrStr, inner] = head;
  const rest = part.slice(whole.length);
  const cls = (attrStr.match(/class="([^"]*)"/) || [, ""])[1];
  if (level === "1") {
    // The H1 block is the abstract shown on the contents page.
    abstract = `<div class="abstract"><h2 class="abstract-title">${inner}</h2>${rest}</div>`;
    continue;
  }
  const numbered = inner.match(/^(\d+)\.\s*(.*)$/s);
  const num = numbered ? numbered[1] : "";
  const title = numbered ? numbered[2] : inner;
  const id = `s-${slug(title)}`;
  toc.push({ id, num, title });
  sections.push(
    `<section id="${id}" class="chapter ${cls}">` +
      `<header class="chapter-head">` +
      (num ? `<span class="chapter-num">${num.padStart(2, "0")}</span>` : "") +
      `<h2 class="chapter-title">${title}</h2></header>` +
      `<div class="chapter-body">${rest}</div>` +
      (cls.split(/\s+/).includes("feature") ? `<img class="feature-symbol" src="{{symbolWhite}}" alt="">` : "") +
      `</section>`,
  );
}
const tocHtml =
  `<ol class="toc">` +
  toc
    .map(
      (t) =>
        `<li><a href="#${t.id}"><span class="toc-num">${t.num.padStart(2, "0")}</span>` +
        `<span class="toc-title">${t.title}</span><span class="toc-page"></span></a></li>`,
    )
    .join("") +
  `</ol>`;

// ---------- assets ----------
const font = (pkg, file) => join(here, "node_modules", pkg, "files", file);
const fonts = [
  ["Archivo", 400, "normal", font("@fontsource/archivo", "archivo-latin-400-normal.woff2")],
  ["Archivo", 400, "italic", font("@fontsource/archivo", "archivo-latin-400-italic.woff2")],
  ["Archivo", 500, "normal", font("@fontsource/archivo", "archivo-latin-500-normal.woff2")],
  ["Archivo", 600, "normal", font("@fontsource/archivo", "archivo-latin-600-normal.woff2")],
  ["Archivo", 700, "normal", font("@fontsource/archivo", "archivo-latin-700-normal.woff2")],
  ["Archivo", 800, "normal", font("@fontsource/archivo", "archivo-latin-800-normal.woff2")],
  ["Archivo Black", 400, "normal", font("@fontsource/archivo-black", "archivo-black-latin-400-normal.woff2")],
  ["IBM Plex Mono", 400, "normal", font("@fontsource/ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2")],
  ["IBM Plex Mono", 500, "normal", font("@fontsource/ibm-plex-mono", "ibm-plex-mono-latin-500-normal.woff2")],
];
let fontCss = "";
for (const [family, weight, style, path] of fonts) {
  fontCss += `@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};font-display:block;src:url(${await dataUri(path, "font/woff2")}) format("woff2");}\n`;
}

const asset = (name) => dataUri(join(here, "assets", name), "image/svg+xml");
const vars = {
  ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, escapeHtml(v)])),
  css: fontCss + (await readFile(join(here, "template", "style.css"), "utf8")),
  wordmarkWhite: await asset("cherrio-wordmark-white.svg"),
  wordmarkCherry: await asset("cherrio-wordmark-cherry.svg"),
  symbolCherry: await asset("cherrio-symbol-cherry.svg"),
  symbolWhite: await asset("cherrio-symbol-white.svg"),
  symbolInk: await asset("cherrio-symbol-ink.svg"),
  wordmarkInk: await asset("cherrio-wordmark-ink.svg"),
  // The official gradient logo (from David, 2026-10-03), used on the cover.
  symbolLogo: await dataUri(join(here, "assets", "cherrio-symbol-logo.png"), "image/png"),
  abstract,
  toc: tocHtml,
  body: "",
  pagedjs: await readFile(join(here, "node_modules", "pagedjs", "dist", "paged.polyfill.min.js"), "utf8"),
};

vars.body = sections.join("\n").replaceAll("{{symbolWhite}}", vars.symbolWhite);

let html = await readFile(join(here, "template", "whitepaper.html"), "utf8");
html = html.replace(/\{\{\{?\s*(\w+)\s*\}?\}\}/g, (m, key) => {
  if (!(key in vars)) throw new Error(`template uses unknown placeholder {{${key}}}`);
  return vars[key];
});

await mkdir(join(here, "build"), { recursive: true });
const htmlPath = join(here, "build", "whitepaper.html");
await writeFile(htmlPath, html);
console.log(`HTML  ${htmlPath}`);
if (htmlOnly) process.exit(0);

// ---------- PDF ----------
const { chromium } = await import("playwright-core");
async function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    (() => {
      try {
        return chromium.executablePath();
      } catch {
        return undefined;
      }
    })(),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      await access(c);
      return c;
    } catch {}
  }
  throw new Error(
    "No Chromium found. Run `npx playwright-core install chromium` or set CHROMIUM_PATH to a Chrome/Chromium binary.",
  );
}

const browser = await chromium.launch({ executablePath: await findChromium() });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(pathToFileURL(htmlPath).href);
  await page.waitForFunction(() => window.__pagedDone === true, null, { timeout: 120_000 });
  const pages = await page.evaluate(() => document.querySelectorAll(".pagedjs_page").length);
  await mkdir(join(here, "dist"), { recursive: true });
  const pdfPath = join(here, "dist", meta.filename);
  await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
  console.log(`PDF   ${pdfPath}  (${pages} pages)`);
} finally {
  await browser.close();
}
