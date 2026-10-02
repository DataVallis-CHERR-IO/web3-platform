import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Private files are encrypted by the app before they reach object storage (ADR-033).
// Stored object: [1 byte format version][12 byte IV][ciphertext][16 byte GCM tag]

const FORMAT_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH;

/** Wrong key, tampered or truncated object, or an object stored under another key. */
export class PrivateFileDecryptError extends Error {
  constructor(reason: string) {
    super(`Private file cannot be decrypted: ${reason}`);
    this.name = "PrivateFileDecryptError";
  }
}

function assertKey(key: Buffer) {
  if (key.length !== 32) throw new Error("[Files] encryption key must be 32 bytes");
}

/**
 * AES-256-GCM with a fresh random IV per file.
 * `storageKey` is authenticated as additional data: an object copied to another
 * key in the bucket does not decrypt. The storage key of a file must therefore
 * never change after upload.
 */
export function encryptPrivateFile(plaintext: Buffer, key: Buffer, storageKey: string): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(storageKey, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, ciphertext, cipher.getAuthTag()]);
}

/**
 * Returns the plaintext only after the GCM tag has been verified.
 * Any failure throws PrivateFileDecryptError — never partial or unverified bytes.
 */
export function decryptPrivateFile(object: Buffer, key: Buffer, storageKey: string): Buffer {
  assertKey(key);
  if (object.length < HEADER_LENGTH + TAG_LENGTH) {
    throw new PrivateFileDecryptError("object is too short");
  }
  if (object[0] !== FORMAT_VERSION) {
    throw new PrivateFileDecryptError("unknown format version");
  }
  const iv = object.subarray(1, HEADER_LENGTH);
  const ciphertext = object.subarray(HEADER_LENGTH, object.length - TAG_LENGTH);
  const tag = object.subarray(object.length - TAG_LENGTH);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(storageKey, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new PrivateFileDecryptError("authentication failed");
  }
}
