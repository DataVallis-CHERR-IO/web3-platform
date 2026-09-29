import { Queue } from "bullmq";
import { Redis } from "ioredis";

export interface HealthJobData {
  ping: string;
  timestamp: number;
}

export interface HealthJobResult {
  pong: string;
  timestamp: number;
  processedAt: number;
}

export const HEALTH_QUEUE_NAME = "health";

export function createHealthQueue(
  redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379"
) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  return new Queue<HealthJobData, HealthJobResult>(HEALTH_QUEUE_NAME, {
    connection,
  });
}
