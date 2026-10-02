import { inspect } from "node:util";

// Keeps the RPC key out of everything this process prints (TASK-027).
// The key is part of the RPC URL (https://host/v2/<key>), and viem puts the full
// URL into its error messages ("URL: …"), which Ponder and Node then print.
// Instead of chasing every print site, stdout and stderr are filtered by value.

type Env = Record<string, string | undefined>;

const MASK = "***";
/** Shorter values are not treated as secrets, so we can never blank out normal text. */
const MIN_SECRET_LENGTH = 8;
/** Safety net for provider-style paths even if the value-based list misses something. */
const KEY_PATH_PATTERN = /\/v2\/[A-Za-z0-9_-]{16,}/g;

const INSTALLED = Symbol.for("cherrio.indexer.redaction");
type Replacement = [from: string, to: string];
type RedactionState = { replacements: Replacement[] };

function withEncoded(value: string): string[] {
  const encoded = encodeURIComponent(value);
  return encoded === value ? [value] : [value, encoded];
}

/** What to replace, longest first: full RPC URLs, then their secret parts. */
export function collectReplacements(env: Env): Replacement[] {
  const replacements = new Map<string, string>();

  for (const [name, url] of Object.entries(env)) {
    if (!name.startsWith("PONDER_RPC_URL_") || !url) continue;

    const secrets: string[] = [];
    try {
      const parsed = new URL(url);
      const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
      if (lastSegment) secrets.push(decodeURIComponent(lastSegment), lastSegment);
      // Raw (as written in the URL) and decoded: searchParams alone would lose "+" and "%xx".
      for (const pair of parsed.search.slice(1).split("&")) {
        const raw = pair.slice(pair.indexOf("=") + 1);
        if (pair.includes("=") && raw) secrets.push(raw);
      }
      for (const value of parsed.searchParams.values()) secrets.push(value);
      if (parsed.password) secrets.push(decodeURIComponent(parsed.password), parsed.password);
    } catch {
      // Not a URL: nothing to take apart; the full value is still masked below.
    }
    const longEnough = [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LENGTH);

    // The masked URL keeps host and path shape (…/v2/***) so logs stay useful.
    let maskedUrl = url;
    for (const secret of longEnough) {
      for (const form of withEncoded(secret)) maskedUrl = maskedUrl.split(form).join(MASK);
    }
    if (longEnough.length > 0 || url.length >= MIN_SECRET_LENGTH) {
      for (const form of withEncoded(url)) {
        replacements.set(form, form === url ? maskedUrl : encodeURIComponent(maskedUrl));
      }
    }
    for (const secret of longEnough) {
      for (const form of withEncoded(secret)) replacements.set(form, MASK);
    }
  }

  return [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);
}

export function redact(text: string, replacements: Replacement[]): string {
  let result = text;
  for (const [from, to] of replacements) {
    if (from !== to && result.includes(from)) result = result.split(from).join(to);
  }
  return result.replace(KEY_PATH_PATTERN, `/v2/${MASK}`);
}

/**
 * Ponder's JSON log format writes to the file descriptor directly, past
 * process.stdout — the redaction would silently not apply. Refuse it.
 */
export function assertSupportedLogFormat(argv: readonly string[]): void {
  const index = argv.indexOf("--log-format");
  const format = index >= 0 ? argv[index + 1] : argv.find((a) => a.startsWith("--log-format="))?.split("=")[1];
  if (format === "json") {
    throw new Error(
      "[Indexer] --log-format json is not supported: Ponder then writes logs directly to the " +
        "file descriptor, where the RPC key redaction cannot filter them. Use the default (pretty) format."
    );
  }
}

function patch(stream: NodeJS.WriteStream, state: RedactionState) {
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      return original(redact(chunk, state.replacements), ...rest);
    }
    if (chunk instanceof Uint8Array) {
      const text = Buffer.from(chunk).toString("utf8");
      const clean = redact(text, state.replacements);
      return original(clean === text ? chunk : Buffer.from(clean, "utf8"), ...rest);
    }
    return original(chunk, ...rest);
  }) as typeof stream.write;
}

/**
 * Filters stdout and stderr of this process. Idempotent; call it before anything
 * else can print. Does not touch exit codes, signals or the RPC itself.
 */
export function installRedaction(env: Env = process.env, argv: readonly string[] = process.argv): void {
  assertSupportedLogFormat(argv);
  const replacements = collectReplacements(env);
  const globals = globalThis as { [INSTALLED]?: RedactionState };
  const existing = globals[INSTALLED];
  if (existing) {
    existing.replacements = replacements; // config reload: refresh the values only
    return;
  }
  const state: RedactionState = { replacements };
  globals[INSTALLED] = state;
  patch(process.stdout, state);
  patch(process.stderr, state);
}

/** Prints through the (redacted) stderr and exits 1. */
export function exitWithError(error: unknown): never {
  process.stderr.write(`${inspect(error, { depth: 6 })}\n`);
  process.exit(1);
}

/**
 * For our own scripts only (reconcile, prune): Node prints a fatal uncaught error
 * straight to file descriptor 2, past the filter above, so print it ourselves.
 * Not for ponder.config.ts — Ponder has its own handlers and graceful shutdown.
 */
export function installFatalHandlers(): void {
  process.on("uncaughtException", exitWithError);
  process.on("unhandledRejection", exitWithError);
}
