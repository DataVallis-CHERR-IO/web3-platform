import { randomBytes, randomUUID } from "node:crypto";
import { decryptPrivateFile, encryptPrivateFile } from "./crypto";
import { CURRENT_KEY_VERSION, defaultDeps, type StorageDeps } from "./storage";

// `files:check` — run after every deploy. Proves that the bucket is reachable
// and writable with the configured credentials, and that PRIVATE_FILES_KEY is
// still the key the stored files were encrypted with.
// Everything lives under `check/`, which `files:sweep` never touches.

/** Fixed, non-personal plaintext; one canary per key version. */
const CANARY_TEXT = Buffer.from("CHERR.IO private files canary");
export const canaryKey = (keyVersion: number = CURRENT_KEY_VERSION) => `check/canary-v${keyVersion}`;

export async function checkPrivateStorage(
  deps: StorageDeps = defaultDeps()
): Promise<{ canary: "created" | "verified" }> {
  await deps.store.check();

  const probeKey = `check/probe-${randomUUID()}`;
  const probe = randomBytes(32);
  try {
    await deps.store.put(probeKey, encryptPrivateFile(probe, deps.key, probeKey));
    const stored = await deps.store.get(probeKey);
    if (!stored || !decryptPrivateFile(stored, deps.key, probeKey).equals(probe)) {
      throw new Error("[Files] probe object did not come back unchanged");
    }
  } finally {
    await deps.store.delete(probeKey);
  }

  // First deploy with this key version: no canary yet, so it is created.
  // Later deploys must be able to decrypt it — a changed or mistyped key fails
  // here, before any real file becomes unreadable.
  const key = canaryKey();
  const existing = await deps.store.get(key);
  if (!existing) {
    await deps.store.put(key, encryptPrivateFile(CANARY_TEXT, deps.key, key));
    return { canary: "created" };
  }
  let plaintext: Buffer;
  try {
    plaintext = decryptPrivateFile(existing, deps.key, key);
  } catch {
    throw new Error("[Files] PRIVATE_FILES_KEY does not match the key the stored files were encrypted with");
  }
  if (!plaintext.equals(CANARY_TEXT)) throw new Error("[Files] canary object has unexpected content");
  return { canary: "verified" };
}
