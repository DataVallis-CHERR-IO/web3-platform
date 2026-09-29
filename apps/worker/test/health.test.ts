import { describe, it, expect } from "vitest";
import type { Job } from "bullmq";
import { processHealthJob } from "../src/workers/health.js";
import type { HealthJobData, HealthJobResult } from "../src/queues/health.js";

describe("processHealthJob", () => {
  it("processes a health check job and returns pong with timestamp", async () => {
    const timestamp = Date.now();
    const mockJob = {
      id: "test-health-1",
      name: "health-ping",
      data: {
        ping: "cherr.io",
        timestamp,
      },
    } as unknown as Job<HealthJobData, HealthJobResult>;

    const result = await processHealthJob(mockJob);

    expect(result.pong).toBe("cherr.io");
    expect(result.timestamp).toBe(timestamp);
    expect(result.processedAt).toBeGreaterThanOrEqual(timestamp);
  });
});
