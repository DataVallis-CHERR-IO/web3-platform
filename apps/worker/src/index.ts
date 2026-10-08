import { createServer } from "node:http";
import { createDb } from "@cherrio/db";
import { loadConfig } from "./config.js";
import { smtpMailer } from "./mailer.js";
import { tick } from "./run.js";
import { newPointsCursor } from "./points.js";
import { importUk, lastUkImport } from "./registry/uk.js";
import { importUs, lastUsImport } from "./registry/us.js";
import { computeTrustScores, type TrustScope } from "./trust.js";

// CHERR.IO worker (TASK-033e, ADR-048): every WORKER_INTERVAL_MS (default 60 s)
// awards vote points, queues lifecycle emails and sends them. Postgres is the
// queue; there is no Redis. /health is 200 while ticks keep completing — the
// Docker HEALTHCHECK (and so Kamal) relies on it.

const config = loadConfig();
const db = createDb(config.databaseUrl, { max: 3 });
const mailer = config.smtp ? smtpMailer(config.smtp) : null;
console.log(
  `[worker] started; email sending ${mailer ? `on (${config.smtp!.host}:${config.smtp!.port})` : "off (no SMTP credentials)"}; registry import ${config.registryImport.join(",") || "off"}`
);

let lastOk = Date.now();
// Points watermarks (VOTE-POINTS-WATERMARK, TASK-056): in memory; a restart starts with a full pass.
const pointsCursor = newPointsCursor();
let running = false;
let stopping = false;

async function loop() {
  if (running || stopping) return;
  running = true;
  try {
    const r = await tick(db, { mailer, appBaseUrl: config.appBaseUrl, pointsCursor });
    lastOk = Date.now();
    const queued = r.queued ? Object.values(r.queued).reduce((a, b) => a + b, 0) : null;
    if ((r.points ?? 0) > 0 || (queued ?? 0) > 0 || (r.sent && r.sent.sent + r.sent.skipped + r.sent.failed > 0) || r.points === null) {
      console.log("[worker] tick", JSON.stringify({ points: r.points, queued: r.queued, sent: r.sent }));
    }
  } catch (e) {
    console.error("[worker] tick failed:", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

// Registry imports (TASK-016): each once a month, in the background and one at a
// time, so ticks keep running.
const REGISTRY_EVERY_MS = 30 * 24 * 3600_000;
const REGISTRIES = {
  uk: { last: lastUkImport, run: () => importUk(db) },
  us: { last: lastUsImport, run: () => importUs(db, undefined, config.usMinRevenue) },
} as const;
let registryCheckedAt = 0;
let importing = false;
async function registry() {
  if (config.registryImport.length === 0 || importing || stopping || Date.now() - registryCheckedAt < 3600_000) return;
  registryCheckedAt = Date.now();
  for (const name of config.registryImport as (keyof typeof REGISTRIES)[]) {
    const last = await REGISTRIES[name].last(db).catch(() => undefined);
    if (last === undefined || (last && Date.now() - last.getTime() < REGISTRY_EVERY_MS)) continue;
    importing = true;
    const started = Date.now();
    console.log(`[worker] ${name.toUpperCase()} registry import started`);
    REGISTRIES[name]
      .run()
      .then((r) => console.log(`[worker] ${name.toUpperCase()} registry import done`, JSON.stringify({ ...r, seconds: Math.round((Date.now() - started) / 1000) })))
      .catch((e) => console.error(`[worker] ${name.toUpperCase()} registry import failed:`, e instanceof Error ? e.message : e))
      .finally(() => {
        importing = false;
        registryCheckedAt = 0; // look at the next registry on the following tick
        trustFullAt = 0; // new imported organisations get their score
      });
    return;
  }
}

// Trust Score v1 (TASK-017a, ADR-059): organisations on CHERR.IO every 10 minutes
// (ratings, campaign outcomes, KYB decisions), everything at start, nightly
// after 03:00 UTC and after a registry import. Only changed rows are written.
let trustRegisteredAt = 0;
let trustFullAt = 0;
let trustFullFailedAt = 0; // a failed full pass waits 30 minutes (it reads every organisation)
let scoring = false;
async function trust() {
  if (scoring || stopping || importing) return;
  const now = new Date();
  const nightly = now.getUTCHours() === 3 && Date.now() - trustFullAt > 12 * 3600_000;
  const scope: TrustScope | null =
    (trustFullAt === 0 || nightly) && Date.now() - trustFullFailedAt >= 30 * 60_000 ? "all" : Date.now() - trustRegisteredAt >= 10 * 60_000 ? "registered" : null;
  if (!scope) return;
  scoring = true;
  const started = Date.now();
  try {
    const r = await computeTrustScores(db, scope);
    if (scope === "all") trustFullAt = Date.now();
    trustRegisteredAt = Date.now();
    if (r.written > 0 || scope === "all") console.log("[worker] trust scores", JSON.stringify({ ...r, ms: Date.now() - started }));
  } catch (e) {
    trustRegisteredAt = Date.now(); // try again in 10 minutes (chain views may be rebuilding)
    if (scope === "all") trustFullFailedAt = Date.now();
    console.error(`[worker] trust scores (${scope}) failed:`, e instanceof Error ? e.message : e);
  } finally {
    scoring = false;
  }
}

const timer = setInterval(() => {
  void loop();
  void registry();
  void trust();
}, config.intervalMs);
void registry();
void loop();

const server = createServer((req, res) => {
  const healthy = Date.now() - lastOk < Math.max(5 * 60_000, 3 * config.intervalMs);
  res.writeHead(req.url === "/health" && healthy ? 200 : req.url === "/health" ? 503 : 404, { "Content-Type": "text/plain" });
  res.end(healthy ? "ok" : "stale");
}).listen(config.healthPort, "0.0.0.0");

const shutdown = () => {
  stopping = true;
  clearInterval(timer);
  server.close();
  const wait = setInterval(() => {
    if (!running) {
      clearInterval(wait);
      void db.$client.end().finally(() => process.exit(0));
    }
  }, 200);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
