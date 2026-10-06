import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAddress } from "viem";
import {
  batchIntervalSeconds, campaignFromCreatedLog, endBlockFromEnv, finalityBlocks, indexedBlockFromStatus, indexerMode,
  logRanges, nextEndBlock, nextScanRange,
} from "../lib/batch";
import { resolveIndexerEnv } from "../lib/env";

// TASK-048 / ADR-055: the pure parts of the batch runner.

describe("indexerMode", () => {
  it("defaults to realtime and refuses unknown modes", () => {
    expect(indexerMode({})).toBe("realtime");
    expect(indexerMode({ INDEXER_MODE: "" })).toBe("realtime");
    expect(indexerMode({ INDEXER_MODE: "batch" })).toBe("batch");
    expect(() => indexerMode({ INDEXER_MODE: "Batch" })).toThrow(/INDEXER_MODE/);
  });
});

describe("batchIntervalSeconds", () => {
  it("defaults to 120 s and accepts 5–900 whole seconds only", () => {
    expect(batchIntervalSeconds({})).toBe(120);
    expect(batchIntervalSeconds({ INDEXER_BATCH_INTERVAL_SECONDS: "300" })).toBe(300);
    for (const bad of ["4", "901", "60.5", "abc"]) {
      expect(() => batchIntervalSeconds({ INDEXER_BATCH_INTERVAL_SECONDS: bad })).toThrow(/between 5 and 900/);
    }
  });
});

describe("cycle end block", () => {
  it("stays Ponder's finality depth behind the head (Amoy 30, Polygon 200)", () => {
    expect(finalityBlocks(80002)).toBe(30);
    expect(finalityBlocks(31337)).toBe(30);
    expect(finalityBlocks(137)).toBe(200);
    expect(nextEndBlock(1_000n, 80002, null)).toBe(970n);
    expect(nextEndBlock(1_000n, 137, null)).toBe(800n);
  });

  it("skips a cycle when nothing new is final, and a chain shorter than the depth", () => {
    expect(nextEndBlock(1_000n, 80002, 970n)).toBeNull();
    expect(nextEndBlock(1_001n, 80002, 970n)).toBe(971n);
    expect(nextEndBlock(20n, 80002, null)).toBeNull();
  });
});

describe("INDEXER_END_BLOCK", () => {
  it("is optional and must be a non-negative integer", () => {
    expect(endBlockFromEnv({})).toBeUndefined();
    expect(endBlockFromEnv({ INDEXER_END_BLOCK: "49017092" })).toBe(49_017_092);
    for (const bad of ["-1", "1.5", "x"]) expect(() => endBlockFromEnv({ INDEXER_END_BLOCK: bad })).toThrow(/INDEXER_END_BLOCK/);
  });

  it("reaches the indexer config", () => {
    const env = resolveIndexerEnv({
      APP_ENV: "dev", PONDER_RPC_URL_80002: "http://rpc.example/v2/key", DATABASE_URL_DIRECT: "postgres://u:p@db:5432/x",
      INDEXER_END_BLOCK: "123",
    });
    expect(env.endBlock).toBe(123);
    expect(env.disableCache).toBe(false);
  });
});

describe("indexedBlockFromStatus", () => {
  it("reads Ponder's /status for the chain named cherrio", () => {
    expect(indexedBlockFromStatus({ cherrio: { id: 80002, block: { number: 42, timestamp: 1 } } })).toBe(42);
    expect(indexedBlockFromStatus({ other: { block: { number: 42 } } })).toBe(-1);
    expect(indexedBlockFromStatus(null)).toBe(-1);
  });
});

describe("factory scan (runner)", () => {
  it("splits a block span into inclusive ranges of at most 50,000 blocks", () => {
    expect(logRanges(10n, 9n)).toEqual([]);
    expect(logRanges(0n, 0n)).toEqual([[0n, 0n]]);
    expect(logRanges(49_017_092n, 49_117_092n)).toEqual([
      [49_017_092n, 49_067_091n], [49_067_092n, 49_117_091n], [49_117_092n, 49_117_092n],
    ]);
    expect(logRanges(1n, 10n, 4n)).toEqual([[1n, 4n], [5n, 8n], [9n, 10n]]);
  });

  it("halves a refused scan range down to 10 blocks, then gives up", () => {
    expect(nextScanRange(50_000n)).toBe(25_000n);
    expect(nextScanRange(15n)).toBe(10n);
    expect(nextScanRange(10n)).toBeNull();
  });

  it("reads the campaign address from topic 1 of CampaignCreated", () => {
    const topic1 = `0x000000000000000000000000${"AbCd".repeat(10)}`;
    expect(campaignFromCreatedLog({ topics: ["0xsig", topic1] })).toBe(`0x${"abcd".repeat(10)}`);
    expect(() => campaignFromCreatedLog({ topics: ["0xsig"] })).toThrow(/campaign topic/);
  });

  it("hands the list to the config through INDEXER_CAMPAIGNS_FILE (batch mode only)", () => {
    const base = { APP_ENV: "dev", PONDER_RPC_URL_80002: "http://rpc.example/v2/key", DATABASE_URL_DIRECT: "postgres://u:p@db:5432/x" };
    expect(resolveIndexerEnv(base).campaignAddresses).toBeUndefined();
    const dir = mkdtempSync(path.join(os.tmpdir(), "cherrio-batch-"));
    const file = path.join(dir, "campaigns.json");
    writeFileSync(file, JSON.stringify([`0x${"ab".repeat(20)}`]));
    expect(resolveIndexerEnv({ ...base, INDEXER_CAMPAIGNS_FILE: file }).campaignAddresses).toEqual([getAddress(`0x${"ab".repeat(20)}`)]);
    writeFileSync(file, JSON.stringify({ not: "a list" }));
    expect(() => resolveIndexerEnv({ ...base, INDEXER_CAMPAIGNS_FILE: file })).toThrow(/JSON array/);
  });
});
