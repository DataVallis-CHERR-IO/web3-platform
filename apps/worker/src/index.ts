import { createServer } from "node:http";
import { createDb } from "@cherrio/db";
import { loadConfig } from "./config.js";
import { smtpMailer } from "./mailer.js";
import { tick } from "./run.js";
import { newPointsCursor } from "./points.js";
import { importUk, lastUkImport } from "./registry/uk.js";

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

// Registry import (TASK-016a): once a month, in the background, so ticks keep running.
const REGISTRY_EVERY_MS = 30 * 24 * 3600_000;
let registryCheckedAt = 0;
let importing = false;
async function registry() {
  if (!config.registryImport.includes("uk") || importing || stopping || Date.now() - registryCheckedAt < 3600_000) return;
  registryCheckedAt = Date.now();
  const last = await lastUkImport(db).catch(() => undefined);
  if (last === undefined || (last && Date.now() - last.getTime() < REGISTRY_EVERY_MS)) return;
  importing = true;
  const started = Date.now();
  console.log("[worker] UK registry import started");
  importUk(db)
    .then((r) => console.log("[worker] UK registry import done", JSON.stringify({ ...r, seconds: Math.round((Date.now() - started) / 1000) })))
    .catch((e) => console.error("[worker] UK registry import failed:", e instanceof Error ? e.message : e))
    .finally(() => {
      importing = false;
    });
}

const timer = setInterval(() => {
  void loop();
  void registry();
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
