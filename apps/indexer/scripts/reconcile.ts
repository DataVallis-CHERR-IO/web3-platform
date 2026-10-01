/**
 * pnpm --filter indexer reconcile
 * Compares the indexed rows with the contract views and exits 1 on any mismatch.
 * Env: APP_ENV, PONDER_RPC_URL_<chainId>, DATABASE_URL_DIRECT,
 *      RECONCILE_SCHEMA (default "chain", the stable views of ADR-026).
 */
import postgres from "postgres";
import { createPublicClient, http } from "viem";
import { resolveIndexerEnv } from "../lib/env";
import { reconcile } from "../lib/reconcile";

const env = resolveIndexerEnv();
const schema = process.env.RECONCILE_SCHEMA ?? "chain";
const sql = postgres(env.databaseUrl, { max: 1 });
const client = createPublicClient({ transport: http(env.rpcUrl, { batch: true }) });

try {
  const result = await reconcile({
    sql,
    schema,
    client,
    factory: env.campaignFactory.address,
    pool: env.emergencyPool.address,
  });
  for (const m of result.mismatches) {
    console.log(
      `MISMATCH ${m.table} ${m.key} ${m.field}: indexed=${m.indexed} onchain=${m.onchain}`
    );
  }
  console.log(
    `reconcile: schema=${schema} block=${result.block} checked=${result.checked} mismatches: ${result.mismatches.length}`
  );
  process.exitCode = result.mismatches.length === 0 ? 0 : 1;
} finally {
  await sql.end();
}
