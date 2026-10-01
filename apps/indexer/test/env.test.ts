import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { resolveIndexerEnv } from "../lib/env";

const DIRECT = "postgres://u:p@cherrio-infra-postgres-1:5432/cherrio_dev";
const dev = {
  APP_ENV: "dev",
  PONDER_RPC_URL_80002: "https://rpc.example/amoy",
  DATABASE_URL_DIRECT: DIRECT,
};

describe("resolveIndexerEnv", () => {
  it("dev → Amoy 80002 with addresses and startBlock from amoy-dev.json", () => {
    const env = resolveIndexerEnv(dev);
    expect(env.chainId).toBe(80002);
    expect(env.rpcUrl).toBe("https://rpc.example/amoy");
    expect(env.databaseUrl).toBe(DIRECT);
    expect(env.disableCache).toBe(false);
    expect(env.campaignFactory).toEqual({
      address: "0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00",
      startBlock: 49017092,
    });
    expect(env.emergencyPool).toEqual({
      address: "0xFa7Fd0253813E196d74575A8F93ABB91cd009517",
      startBlock: 49017092,
    });
  });

  it("throws without APP_ENV", () => {
    expect(() => resolveIndexerEnv({ ...dev, APP_ENV: undefined })).toThrow("APP_ENV is not set");
  });

  it("throws without the RPC URL of the selected chain", () => {
    expect(() => resolveIndexerEnv({ ...dev, PONDER_RPC_URL_80002: undefined })).toThrow(
      "PONDER_RPC_URL_80002 is not set"
    );
  });

  it("throws for an environment that has no deployment yet", () => {
    expect(() =>
      resolveIndexerEnv({ ...dev, APP_ENV: "uat" })
    ).toThrow('Contracts not deployed for environment "uat"');
  });

  it("never falls back to DATABASE_URL", () => {
    expect(() =>
      resolveIndexerEnv({ ...dev, DATABASE_URL_DIRECT: undefined, DATABASE_URL: DIRECT })
    ).toThrow("DATABASE_URL_DIRECT is not set");
  });

  it("refuses a PgBouncer URL", () => {
    for (const url of [
      "postgres://u:p@cherrio-infra-pgbouncer-1:6432/cherrio_dev",
      "postgres://u:p@10.0.0.5:6432/cherrio_dev",
      "postgres://u:p@pgbouncer:5432/cherrio_dev",
    ]) {
      expect(() => resolveIndexerEnv({ ...dev, DATABASE_URL_DIRECT: url })).toThrow(
        "points at PgBouncer"
      );
    }
  });

  it("local → deployment from INDEXER_DEPLOYMENT_FILE, cache disabled", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "indexer-env-")), "local.json");
    writeFileSync(
      file,
      JSON.stringify({
        chainId: 80002,
        contracts: {
          campaignFactory: { address: "0x5fbdb2315678afecb367f032d93f642f64180aa3", startBlock: 3 },
          emergencyPool: { address: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512", startBlock: 4 },
        },
      })
    );
    const env = resolveIndexerEnv({
      APP_ENV: "local",
      INDEXER_DEPLOYMENT_FILE: file,
      PONDER_RPC_URL_80002: "http://127.0.0.1:8545",
      DATABASE_URL_DIRECT: "postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev",
    });
    expect(env.disableCache).toBe(true);
    expect(env.campaignFactory.startBlock).toBe(3);
    expect(env.emergencyPool.address).toBe("0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512");
  });

  it("local without INDEXER_DEPLOYMENT_FILE throws", () => {
    expect(() => resolveIndexerEnv({ ...dev, APP_ENV: "local" })).toThrow(
      "INDEXER_DEPLOYMENT_FILE is required"
    );
  });
});
