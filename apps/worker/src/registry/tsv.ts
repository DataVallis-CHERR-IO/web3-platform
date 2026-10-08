import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import yauzl from "yauzl";

// Reading the Charity Commission's tab-separated extracts (TASK-016a) as a
// stream: one row at a time, so a 170,000-charity file never sits in memory
// (the worker has 128 MB of heap).

/** Opens the first `.txt` file inside a zip as a stream. */
export function openZippedText(path: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip not readable"));
      zip.on("error", reject);
      zip.on("entry", (entry: yauzl.Entry) => {
        if (!/\.txt$/i.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => (e || !stream ? reject(e ?? new Error("entry not readable")) : resolve(stream)));
      });
      zip.on("end", () => reject(new Error("no .txt file in the zip")));
      zip.readEntry();
    });
  });
}

/**
 * Rows of a tab-separated file with a header line, as objects keyed by the
 * header. A record whose text contains a line break arrives over several lines:
 * lines are joined (with a space) until the row has as many fields as the header.
 * Backslash escapes (`\\t`, `\\n`, `\\\\`) are undone.
 */
export async function* tsvRows(input: Readable): AsyncGenerator<Record<string, string>> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header: string[] | null = null;
  let pending = "";
  for await (const raw of lines as AsyncIterable<string>) {
    const line: string = header === null ? raw.replace(/^\uFEFF/, "") : raw;
    if (header === null) {
      header = line.split("\t").map((h) => h.trim());
      continue;
    }
    pending = pending ? `${pending} ${line}` : line;
    const fields = pending.split("\t");
    if (fields.length < header.length) continue;
    pending = "";
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = unescape(fields[i] ?? "").trim()));
    yield row;
  }
}

const unescape = (s: string) => s.replace(/\\(t|n|r|\\)/g, (_, c: string) => (c === "t" ? "\t" : c === "n" ? "\n" : c === "r" ? "" : "\\"));

export function fileStream(path: string): Readable {
  return createReadStream(path);
}
