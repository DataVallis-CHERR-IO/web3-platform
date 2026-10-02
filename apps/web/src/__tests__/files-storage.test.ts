import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PrivateFileDecryptError } from "@/lib/files/crypto";
import { FileRejectedError } from "@/lib/files/file-type";
import type { ObjectStore } from "@/lib/files/s3";
import {
  deletePrivateFile,
  getPrivateFile,
  kybStorageKey,
  putPrivateFile,
  type StorageDeps,
} from "@/lib/files/storage";

/** In-memory object store: what would be sent to the bucket. */
function memoryStore() {
  const objects = new Map<string, Buffer>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, Buffer.from(body)),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
    list: async (prefix) =>
      [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, lastModified: undefined })),
    check: async () => {},
  };
  return { objects, store };
}

const FILE_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ORG_ID = "0199a1b2-0000-7000-8000-000000000001";
const pdf = Buffer.concat([Buffer.from("%PDF-1.7\ndummy statute, generated for tests\n"), randomBytes(64)]);

function setup() {
  const { objects, store } = memoryStore();
  const deps: StorageDeps = { store, key: randomBytes(32) };
  return { objects, deps };
}

describe("private file storage", () => {
  it("what reaches the store is not the plaintext", async () => {
    const { objects, deps } = setup();
    const storageKey = kybStorageKey(FILE_ID);
    await putPrivateFile({ storageKey, bytes: pdf }, deps);

    const stored = objects.get(storageKey)!;
    expect(stored).toBeDefined();
    expect(stored.includes(pdf.subarray(0, 8))).toBe(false); // "%PDF-1.7"
    expect(stored.includes(Buffer.from("dummy statute"))).toBe(false);
    expect(stored.length).toBe(pdf.length + 29);
  });

  it("put returns type, size and SHA-256 of the plaintext; get returns the original bytes", async () => {
    const { deps } = setup();
    const storageKey = kybStorageKey(FILE_ID, ORG_ID);
    const stored = await putPrivateFile({ storageKey, bytes: pdf }, deps);

    expect(stored).toEqual({
      storageKey: `kyb/${ORG_ID}/${FILE_ID}`,
      mimeType: "application/pdf",
      extension: "pdf",
      sizeBytes: pdf.length,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      keyVersion: 1,
    });
    expect((await getPrivateFile(storageKey, deps))!.equals(pdf)).toBe(true);
  });

  it("a rejected file is never stored", async () => {
    const { objects, deps } = setup();
    const html = Buffer.from("<html>renamed.pdf</html>");
    await expect(putPrivateFile({ storageKey: kybStorageKey(FILE_ID), bytes: html }, deps)).rejects.toThrow(
      FileRejectedError
    );
    expect(objects.size).toBe(0);
  });

  it("a tampered object, a wrong key or a moved object throws instead of returning a file", async () => {
    const { objects, deps } = setup();
    const storageKey = kybStorageKey(FILE_ID);
    await putPrivateFile({ storageKey, bytes: pdf }, deps);

    await expect(getPrivateFile(storageKey, { ...deps, key: randomBytes(32) })).rejects.toThrow(PrivateFileDecryptError);

    const otherKey = kybStorageKey("0199a1b2-c3d4-7e5f-8a9b-ffffffffffff");
    objects.set(otherKey, objects.get(storageKey)!);
    await expect(getPrivateFile(otherKey, deps)).rejects.toThrow(PrivateFileDecryptError);

    const tampered = Buffer.from(objects.get(storageKey)!);
    tampered[20] = tampered[20]! ^ 0xff;
    objects.set(storageKey, tampered);
    await expect(getPrivateFile(storageKey, deps)).rejects.toThrow(PrivateFileDecryptError);
  });

  it("get returns null for a missing object; delete removes it", async () => {
    const { objects, deps } = setup();
    const storageKey = kybStorageKey(FILE_ID);
    expect(await getPrivateFile(storageKey, deps)).toBeNull();
    await putPrivateFile({ storageKey, bytes: pdf }, deps);
    await deletePrivateFile(storageKey, deps);
    expect(objects.size).toBe(0);
    expect(await getPrivateFile(storageKey, deps)).toBeNull();
  });
});

describe("storage key", () => {
  it("is built from ids only", () => {
    expect(kybStorageKey(FILE_ID)).toBe(`kyb/unassigned/${FILE_ID}`);
    expect(kybStorageKey(FILE_ID, ORG_ID)).toBe(`kyb/${ORG_ID}/${FILE_ID}`);
  });

  it("refuses anything that is not a UUID, so no user input can enter a key", () => {
    for (const bad of ["passport-jane-doe.pdf", "jane@example.org", "../../etc/passwd", "", `${FILE_ID}/x`, FILE_ID.toUpperCase()]) {
      expect(() => kybStorageKey(bad), bad).toThrow("must be a UUID");
      expect(() => kybStorageKey(FILE_ID, bad), bad).toThrow("must be a UUID");
    }
  });
});
