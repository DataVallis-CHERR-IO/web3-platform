// Admin lists (TASK-029 §3): filter state lives in the URL (shareable, back
// button works), pages are server-rendered, and pagination is keyset-based
// (stable and fast at any depth — no OFFSET).

export const PAGE_SIZE = 50;

export type SearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/** A trimmed search text, at most 100 characters. */
export function searchText(params: SearchParams): string {
  return one(params.q).trim().slice(0, 100);
}

/** One of `allowed`, or `fallback`. */
export function pick<T extends string>(params: SearchParams, key: string, allowed: readonly T[], fallback: T): T {
  const value = one(params[key]);
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** An ILIKE pattern that matches `text` literally anywhere (% and _ escaped). */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * A sort key as Postgres prints it with `sortKey()` — UTC, microseconds. Postgres
 * keeps microseconds and a JS Date only milliseconds, so the key travels as text.
 */
const TIMESTAMP_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Position after the last row of a page: the sort value (timestamp text or null) and the row id. */
export interface Cursor {
  key: string | null;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.key, cursor.id])).toString("base64url");
}

/** A cursor from the URL, or null when absent or malformed (then the first page is shown). */
export function decodeCursor(params: SearchParams): Cursor | null {
  const raw = one(params.after);
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [key, id] = value as [unknown, unknown];
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    if (key !== null && (typeof key !== "string" || !TIMESTAMP_KEY.test(key))) return null;
    return { key: key as string | null, id };
  } catch {
    return null;
  }
}

/** The URL of the same list with some parameters changed (empty values removed). */
export function listHref(path: string, params: SearchParams, change: Record<string, string | null>): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const v = one(value);
    if (v && key !== "after") next.set(key, v);
  }
  for (const [key, value] of Object.entries(change)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  const query = next.toString();
  return query ? `${path}?${query}` : path;
}
