// Worker configuration (TASK-033e, ADR-048). Plain values come from the Kamal
// config; SMTP_USER / SMTP_PASSWORD and DATABASE_URL are secrets. Nothing here
// is ever logged except which features are on.

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

export interface WorkerConfig {
  databaseUrl: string;
  /** Public base URL of the web app for links in emails, e.g. https://dev.cherr.io */
  appBaseUrl: string;
  /** null = sending disabled (points and queueing still run). */
  smtp: SmtpConfig | null;
  intervalMs: number;
  healthPort: number;
  /** Registries to import monthly (TASK-016a): REGISTRY_IMPORT=uk. Empty = off. */
  registryImport: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const appBaseUrl = (env.APP_BASE_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(appBaseUrl)) throw new Error("APP_BASE_URL must be an origin like https://dev.cherr.io");
  const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM } = env;
  const smtp =
    SMTP_HOST && SMTP_USER && SMTP_PASSWORD && MAIL_FROM
      ? { host: SMTP_HOST, port: Number(env.SMTP_PORT ?? 587), user: SMTP_USER, password: SMTP_PASSWORD, from: MAIL_FROM }
      : null;
  return {
    databaseUrl,
    appBaseUrl,
    smtp,
    intervalMs: Number(env.WORKER_INTERVAL_MS ?? 60_000),
    healthPort: Number(env.HEALTH_PORT ?? 8080),
    registryImport: (env.REGISTRY_IMPORT ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s === "uk"),
  };
}
