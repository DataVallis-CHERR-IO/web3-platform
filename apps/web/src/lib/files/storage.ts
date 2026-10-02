import { createHash } from "node:crypto";
import { getPrivateFilesKey, getS3Config } from "./config";
import { decryptPrivateFile, encryptPrivateFile } from "./crypto";
import { checkUpload, type DetectedFileType } from "./file-type";
import { createS3ObjectStore, type ObjectStore } from "./s3";

// Private file storage (ADR-033): every file is checked, hashed and encrypted
// by the app before it is stored. Nothing here logs contents, keys or object keys.

/** Version of PRIVATE_FILES_KEY in use; stored per file for a future key rotation. */
export const CURRENT_KEY_VERSION = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StorageDeps {
  store: ObjectStore;
  key: Buffer;
}

let defaults: StorageDeps | undefined;

/** Created at first use from the environment (missing configuration throws here). */
export function defaultDeps(): StorageDeps {
  defaults ??= { store: createS3ObjectStore(getS3Config()), key: getPrivateFilesKey() };
  return defaults;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * `kyb/<orgId or "unassigned">/<fileId>` — built only from ids we generated.
 * No file name, email or other input from the user ever enters an object key.
 * The key is part of the encryption (see crypto.ts) and must never change after upload.
 */
export function kybStorageKey(fileId: string, orgId?: string): string {
  if (!UUID.test(fileId)) throw new Error("[Files] file id must be a UUID");
  if (orgId !== undefined && !UUID.test(orgId)) throw new Error("[Files] organisation id must be a UUID");
  return `kyb/${orgId ?? "unassigned"}/${fileId}`;
}

export interface StoredPrivateFile {
  storageKey: string;
  mimeType: DetectedFileType["mimeType"];
  extension: DetectedFileType["extension"];
  sizeBytes: number;
  /** SHA-256 of the plaintext, lowercase hex. */
  sha256: string;
  keyVersion: number;
}

/**
 * Checks size and type (magic bytes), then stores the file encrypted.
 * Throws FileRejectedError for a file the user must not upload.
 */
export async function putPrivateFile(
  input: { storageKey: string; bytes: Buffer },
  deps: StorageDeps = defaultDeps()
): Promise<StoredPrivateFile> {
  const type = checkUpload(input.bytes);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const object = encryptPrivateFile(input.bytes, deps.key, input.storageKey);
  await deps.store.put(input.storageKey, object);
  return {
    storageKey: input.storageKey,
    mimeType: type.mimeType,
    extension: type.extension,
    sizeBytes: input.bytes.length,
    sha256,
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/**
 * The decrypted file, or null if the object does not exist.
 * Throws PrivateFileDecryptError if it cannot be verified — never returns unverified bytes.
 */
export async function getPrivateFile(
  storageKey: string,
  deps: StorageDeps = defaultDeps()
): Promise<Buffer | null> {
  const object = await deps.store.get(storageKey);
  if (!object) return null;
  return decryptPrivateFile(object, deps.key, storageKey);
}

export async function deletePrivateFile(
  storageKey: string,
  deps: StorageDeps = defaultDeps()
): Promise<void> {
  await deps.store.delete(storageKey);
}

/**
 * Deletes the object of a file whose row is already marked deleted (or that has
 * no row). A failure is logged without the key and left for `files:sweep`.
 */
export async function removeStoredObject(
  storageKey: string,
  deps: StorageDeps = defaultDeps()
): Promise<boolean> {
  try {
    await deps.store.delete(storageKey);
    return true;
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    console.warn(`[Files] object delete failed (${name}); left for files:sweep`);
    return false;
  }
}
