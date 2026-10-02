import { parseAppEnv } from "@cherrio/shared";

// Runtime configuration for private file storage (ADR-033).
// Read at first use, never at build time: one image runs in every environment.

type Env = Record<string, string | undefined>;

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** `docker-compose.dev.yml` service `s3mock` (accepts any credentials). */
const LOCAL_S3: S3Config = {
  endpoint: "http://127.0.0.1:9090",
  region: "local",
  bucket: "cherrio-private-local",
  accessKeyId: "local",
  secretAccessKey: "local",
};

const S3_VARIABLES = {
  endpoint: "S3_ENDPOINT",
  region: "S3_REGION",
  bucket: "S3_BUCKET",
  accessKeyId: "S3_ACCESS_KEY_ID",
  secretAccessKey: "S3_SECRET_ACCESS_KEY",
} as const;

/**
 * APP_ENV must be set: a missing value never means "local", or a misconfigured
 * server would silently talk to a non-existent local store.
 * Only an explicit APP_ENV=local falls back to the local s3mock for unset variables.
 * In dev/uat/prod every variable is required; the error names the missing
 * variables, never a value.
 */
export function getS3Config(env: Env = process.env): S3Config {
  if (!env.APP_ENV) {
    throw new Error("[Files] APP_ENV is not set");
  }
  const isLocal = parseAppEnv(env.APP_ENV) === "local";
  const config = {} as S3Config;
  const missing: string[] = [];

  for (const [field, variable] of Object.entries(S3_VARIABLES) as [keyof S3Config, string][]) {
    const value = env[variable] || (isLocal ? LOCAL_S3[field] : undefined);
    if (value) config[field] = value;
    else missing.push(variable);
  }
  if (missing.length > 0) {
    throw new Error(`[Files] Missing storage configuration: ${missing.join(", ")}`);
  }
  return config;
}

/**
 * The AES-256 key for private files: base64 of exactly 32 bytes, required in
 * every environment. Losing it makes every stored file unreadable.
 */
export function getPrivateFilesKey(env: Env = process.env): Buffer {
  const encoded = env.PRIVATE_FILES_KEY;
  if (!encoded) {
    throw new Error("[Files] PRIVATE_FILES_KEY is not set");
  }
  const key = Buffer.from(encoded, "base64");
  // Buffer.from is lenient; re-encoding catches values that are not clean base64.
  if (key.length !== 32 || key.toString("base64") !== encoded.trim()) {
    throw new Error("[Files] PRIVATE_FILES_KEY must be base64 of exactly 32 bytes");
  }
  return key;
}
