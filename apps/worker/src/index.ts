import { createHealthWorker } from "./workers/health.js";

console.log("Starting CHERR.IO worker service...");
const healthWorker = createHealthWorker();

healthWorker.on("completed", (job) => {
  console.log(`Job ${job.id} completed with result:`, job.returnvalue);
});

healthWorker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed:`, err);
});
