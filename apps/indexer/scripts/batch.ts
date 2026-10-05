/**
 * Batch mode runner (ADR-055, TASK-048) — `node dist/batch.mjs`, started by the
 * container when INDEXER_MODE=batch (Dockerfile.indexer CMD).
 *
 * Every INDEXER_BATCH_INTERVAL_SECONDS (default 120): read the chain head (one
 * eth_blockNumber), run `ponder start` on the deploy's schema with
 * INDEXER_END_BLOCK = head − finality, wait until Ponder reports that block on
 * its /status, stop it. Ponder resumes the same schema each cycle (crash
 * recovery); PONDER_EXPERIMENTAL_DB=platform lets it do so although the end
 * block — part of Ponder's build id — changes every cycle. Safe here because
 * each code change gets its own schema chain_<sha7> (ADR-026).
 *
 * The runner serves what the deploy and Docker expect on port 42069:
 *   /health  200 while the runner lives (Docker HEALTHCHECK)
 *   /ready   200 once a cycle has completed (deploy job "Wait for /ready")
 *   /status  {"cherrio":{"block":{"number":<last end block>}},"mode":"batch",…}
 * Ponder itself listens on 42070 inside the container during a cycle.
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import postgres from "postgres";
import { batchIntervalSeconds, indexedBlockFromStatus, nextEndBlock } from "../lib/batch";
import { resolveIndexerEnv } from "../lib/env";
import { exitWithError, installFatalHandlers, installRedaction } from "../lib/redact";

installRedaction();
installFatalHandlers();

const PORT = Number(process.env.INDEXER_PORT ?? 42069);
const PONDER_PORT = Number(process.env.INDEXER_PONDER_PORT ?? PORT + 1);
/** A fresh schema backfills from the start block in its first cycle: allow it time. */
const FIRST_CYCLE_TIMEOUT_MS = 60 * 60_000;
const CYCLE_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 30_000;
/** Consecutive failed cycles after which the runner exits (the container restarts, the deploy sees it). */
const MAX_FAILURES = 5;

const log = (msg: string) => console.log(`[indexer:batch] ${new Date().toISOString()} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chainHead(rpcUrl: string): Promise<bigint> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!body.result) throw new Error(`eth_blockNumber failed: ${body.error?.message ?? res.status}`);
  return BigInt(body.result);
}

async function ponderBlock(): Promise<number> {
  try {
    const ready = await fetch(`http://127.0.0.1:${PONDER_PORT}/ready`, { signal: AbortSignal.timeout(5_000) });
    if (ready.status !== 200) return -1;
    const status = await fetch(`http://127.0.0.1:${PONDER_PORT}/status`, { signal: AbortSignal.timeout(5_000) });
    return indexedBlockFromStatus(await status.json());
  } catch {
    return -1;
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
}

/**
 * Ponder's SIGTERM shutdown leaves its schema lock set (`_ponder_meta.is_locked`
 * = 1; seen with Ponder 0.17.12), so the next cycle would wait ~20 s for the
 * heartbeat to expire. The child has exited when this runs, so nobody holds it.
 */
async function releaseLock(sql: postgres.Sql, schema: string): Promise<void> {
  await sql`
    update ${sql(schema)}._ponder_meta
    set value = jsonb_set(value, '{is_locked}', to_jsonb(0))
    where key = 'app'`.catch((e: unknown) => log(`could not release the schema lock: ${e instanceof Error ? e.message : String(e)}`));
}

async function main() {
  const sha = process.env.GIT_SHA7;
  const schema = process.env.INDEXER_SCHEMA ?? (sha ? `chain_${sha}` : undefined);
  if (!schema) throw new Error("[Indexer] GIT_SHA7 (or INDEXER_SCHEMA) is not set");
  const env = resolveIndexerEnv();
  const interval = batchIntervalSeconds();
  const sql = postgres(env.databaseUrl, { max: 1, onnotice: () => {} });

  let lastEnd: bigint | null = null;
  let lastCycleAt: string | null = null;
  let current: ChildProcess | null = null;
  let stopping = false;

  const server = http.createServer((req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return json(200, { ok: true });
    if (req.url === "/ready") return lastEnd === null ? json(503, { ready: false }) : json(200, { ready: true });
    if (req.url === "/status") {
      return json(200, {
        cherrio: { id: env.chainId, block: { number: lastEnd === null ? null : Number(lastEnd) } },
        mode: "batch",
        intervalSeconds: interval,
        lastCycleAt,
      });
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(PORT, "0.0.0.0", () => r()));
  log(`schema ${schema}, chain ${env.chainId}, a cycle every ${interval} s`);

  const shutdown = async () => {
    stopping = true;
    if (current) {
      await stop(current);
      await releaseLock(sql, schema);
    }
    server.close();
    await sql.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  let failures = 0;
  while (!stopping) {
    const started = Date.now();
    try {
      const end = nextEndBlock(await chainHead(env.rpcUrl), env.chainId, lastEnd);
      if (end !== null) {
        const child = spawn(
          "node_modules/.bin/ponder",
          ["start", "--schema", schema, "--views-schema", "chain", "--port", String(PONDER_PORT)],
          { stdio: "inherit", env: { ...process.env, INDEXER_END_BLOCK: end.toString(), PONDER_EXPERIMENTAL_DB: "platform" } }
        );
        current = child;
        const deadline = started + (lastEnd === null ? FIRST_CYCLE_TIMEOUT_MS : CYCLE_TIMEOUT_MS);
        let reached = -1;
        while (Date.now() < deadline && child.exitCode === null && reached < Number(end)) {
          await sleep(1_000);
          reached = await ponderBlock();
        }
        const exitedEarly = child.exitCode !== null;
        await stop(child);
        current = null;
        await releaseLock(sql, schema);
        if (reached < Number(end)) {
          throw new Error(exitedEarly ? `ponder exited with ${child.exitCode} before block ${end}` : `block ${end} not reached in time`);
        }
        lastEnd = end;
        lastCycleAt = new Date().toISOString();
        log(`indexed to block ${end} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      }
      failures = 0;
    } catch (e) {
      failures++;
      log(`cycle failed (${failures}/${MAX_FAILURES}): ${e instanceof Error ? e.message : String(e)}`);
      if (failures >= MAX_FAILURES) throw new Error("[Indexer] too many failed batch cycles");
    }
    const wait = interval * 1000 - (Date.now() - started);
    if (wait > 0 && !stopping) await sleep(wait);
  }
}

main().catch(exitWithError);
