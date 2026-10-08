import net from "node:net";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const REAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };
const PROBE_PASSWORD = "s3cretpw-probe";

/** Fresh module registry per test: getDb() caches its client per DATABASE_URL. */
async function loadHealth() {
  vi.resetModules();
  const { GET } = await import("@/app/api/health/route");
  const { getDb } = await import("@/lib/db");
  return { GET, closeDb: () => getDb().$client.end({ timeout: 0 }) };
}

function setEnv(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("GET /api/health", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    if (!REAL_DATABASE_URL) {
      throw new Error("health tests need a reachable DATABASE_URL");
    }
  });

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ APP_ENV: "local", NEXT_PUBLIC_GIT_SHA: "abc1234" });
  });

  afterEach(() => {
    errorSpy.mockRestore();
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
  });

  function loggedText(): string {
    return errorSpy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
  }

  it("returns 200 with db ok when the database answers", async () => {
    const { GET, closeDb } = await loadHealth();
    try {
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: "ok", db: "ok", env: "local", sha: "abc1234" });
      expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    } finally {
      await closeDb();
    }
  });

  it("reports the version Kamal gives the container (the image holds no commit id)", async () => {
    setEnv({ KAMAL_VERSION: "sha-9f8e7d6" });
    const { GET, closeDb } = await loadHealth();
    try {
      const body = await (await GET()).json();
      expect(body).toMatchObject({ status: "ok", version: "sha-9f8e7d6", sha: "9f8e7d6" });
    } finally {
      await closeDb();
    }
  });

  it("returns 503 db_unreachable quickly when the database refuses the connection", async () => {
    setEnv({ DATABASE_URL: `postgres://probe:${PROBE_PASSWORD}@127.0.0.1:1/nope` });
    const { GET, closeDb } = await loadHealth();
    try {
      const started = Date.now();
      const res = await GET();
      const elapsed = Date.now() - started;
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body).toMatchObject({
        status: "error",
        error: "db_unreachable",
        env: "local",
        sha: "abc1234",
      });
      expect(body.db).toBeUndefined();
      expect(elapsed).toBeLessThan(3_000);

      expect(loggedText()).toContain("[Health] DB check failed:");
      expect(loggedText()).not.toContain(PROBE_PASSWORD);
      expect(JSON.stringify(body)).not.toContain(PROBE_PASSWORD);
    } finally {
      await closeDb();
    }
  });

  it("returns 503 db_unreachable after the 2 s timeout when the database never answers", async () => {
    // Accepts the TCP connection and stays silent, like a hung PgBouncer.
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;

    setEnv({ DATABASE_URL: `postgres://probe:${PROBE_PASSWORD}@127.0.0.1:${port}/nope` });
    const { GET, closeDb } = await loadHealth();
    try {
      const started = Date.now();
      const res = await GET();
      const elapsed = Date.now() - started;
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body).toMatchObject({ status: "error", error: "db_unreachable" });
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(3_000);
      expect(loggedText()).toContain("timed out after 2000 ms");
      expect(loggedText()).not.toContain(PROBE_PASSWORD);
    } finally {
      await closeDb();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns 200 with db skipped in local without DATABASE_URL", async () => {
    setEnv({ DATABASE_URL: undefined, DATABASE_URL_DIRECT: undefined });
    const { GET } = await loadHealth();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", db: "skipped", env: "local", sha: "abc1234" });
  });

  it("returns 503 db_config_error in dev without DATABASE_URL, even if DATABASE_URL_DIRECT works", async () => {
    setEnv({
      APP_ENV: "dev",
      PRIVY_APP_ID: "test-privy-app-id",
      PRIVY_APP_SECRET: "test-privy-app-secret",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      DATABASE_URL: undefined,
      DATABASE_URL_DIRECT: REAL_DATABASE_URL,
    });
    const { GET } = await loadHealth();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toMatchObject({ status: "error", error: "db_config_error", env: "dev" });
    expect(loggedText()).toContain("[Health] DATABASE_URL is not set");
  });
});
