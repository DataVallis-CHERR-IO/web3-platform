import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import {
  HEALTH_QUEUE_NAME,
  type HealthJobData,
  type HealthJobResult,
} from "../queues/health.js";

export async function processHealthJob(
  job: Job<HealthJobData, HealthJobResult>
): Promise<HealthJobResult> {
  return {
    pong: job.data.ping,
    timestamp: job.data.timestamp,
    processedAt: Date.now(),
  };
}

export function createHealthWorker(
  redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379"
) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  return new Worker<HealthJobData, HealthJobResult>(
    HEALTH_QUEUE_NAME,
    processHealthJob,
    { connection }
  );
}
