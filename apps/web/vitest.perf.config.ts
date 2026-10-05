import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TASK-047: `pnpm --filter web perf:campaigns` (see src/__perf__/campaign-lists.perf.ts). Not part of `pnpm test`.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: { include: ["src/__perf__/**/*.perf.ts"], fileParallelism: false, env: { APP_ENV: "local" } },
});
