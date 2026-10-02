import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertSupportedLogFormat, collectReplacements, redact } from "../lib/redact";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexerDir = path.resolve(here, "..");
const tsx = path.join(indexerDir, "node_modules/.bin/tsx");

const KEY = "TESTKEY1234567890";
const URL_WITH_KEY = `https://example.invalid/v2/${KEY}`;

function run(fixture: string, args: string[] = []) {
  const result = spawnSync(tsx, [path.join(here, "fixtures", fixture), ...args], {
    cwd: indexerDir,
    encoding: "utf8",
    env: { ...process.env, PONDER_RPC_URL_80002: URL_WITH_KEY },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("redaction in a real process", () => {
  it("a real viem request error is printed without the key, exit code unchanged", () => {
    const { status, output } = run("redact-viem-error.ts");
    expect(output).toContain("HTTP request failed");
    expect(output).toContain("https://example.invalid/v2/***");
    expect(output).toContain("as bytes: https://example.invalid/v2/***");
    expect(output).not.toContain(KEY);
    expect(status).toBe(7);
  });

  it("an uncaught exception is printed through the filter and exits 1", () => {
    const { status, output } = run("redact-uncaught.ts");
    expect(output).toContain("request failed. URL: https://example.invalid/v2/***");
    expect(output).toContain("inner https://example.invalid/v2/***"); // the cause too
    expect(output).not.toContain(KEY);
    expect(status).toBe(1);
  });

  it("an unhandled rejection is printed through the filter and exits 1", () => {
    const { status, output } = run("redact-uncaught.ts", ["--rejection"]);
    expect(output).toContain("request failed. URL: https://example.invalid/v2/***");
    expect(output).not.toContain(KEY);
    expect(status).toBe(1);
  });
});

describe("redact by value", () => {
  const env = {
    PONDER_RPC_URL_80002: URL_WITH_KEY,
    PONDER_RPC_URL_137: "https://rpc.example/path/abc?apikey=Q+Secret/Value=99&x=1",
    PONDER_RPC_URL_31337: "http://127.0.0.1:8545",
    DATABASE_URL_DIRECT: "postgres://not-an-rpc-url",
  };
  const clean = (text: string) => redact(text, collectReplacements(env));

  it("masks the full URL and the bare key", () => {
    expect(clean(`URL: ${URL_WITH_KEY}`)).toBe("URL: https://example.invalid/v2/***");
    expect(clean(`key=${KEY};`)).toBe("key=***;");
  });

  it("masks query values and URL-encoded forms", () => {
    expect(clean("apikey=Q+Secret/Value=99")).toBe("apikey=***");
    expect(clean(encodeURIComponent("Q+Secret/Value=99"))).toBe("***");
    expect(clean(encodeURIComponent(URL_WITH_KEY))).not.toContain(KEY);
  });

  it("leaves short values and non-RPC variables alone", () => {
    expect(clean("x=1 and abc and http://127.0.0.1:8545")).toBe("x=1 and abc and http://127.0.0.1:8545");
    expect(clean("postgres://not-an-rpc-url")).toBe("postgres://not-an-rpc-url");
    expect(collectReplacements({ PONDER_RPC_URL_1: "" })).toEqual([]);
  });

  it("safety net: a provider-style key path is masked even when it is not a known value", () => {
    expect(clean("https://other.example/v2/abcdefghijklmnop1234")).toBe("https://other.example/v2/***");
    expect(clean("/v2/short")).toBe("/v2/short");
  });
});

describe("log format", () => {
  it("refuses --log-format json, in both spellings", () => {
    expect(() => assertSupportedLogFormat(["node", "ponder", "start", "--log-format", "json"])).toThrow(
      "--log-format json is not supported"
    );
    expect(() => assertSupportedLogFormat(["node", "ponder", "start", "--log-format=json"])).toThrow(
      "--log-format json is not supported"
    );
  });

  it("accepts the default and pretty", () => {
    expect(() => assertSupportedLogFormat(["node", "ponder", "start"])).not.toThrow();
    expect(() => assertSupportedLogFormat(["node", "ponder", "start", "--log-format", "pretty"])).not.toThrow();
  });
});
