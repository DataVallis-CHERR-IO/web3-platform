import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getPrivateFilesKey, getS3Config } from "@/lib/files/config";
import { decryptPrivateFile, encryptPrivateFile, PrivateFileDecryptError } from "@/lib/files/crypto";

const key = randomBytes(32);
const STORAGE_KEY = "kyb/unassigned/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const plaintext = Buffer.from("%PDF-1.7 dummy document body, generated for tests");

describe("private file encryption", () => {
  it("round trip returns the original bytes", () => {
    const object = encryptPrivateFile(plaintext, key, STORAGE_KEY);
    expect(decryptPrivateFile(object, key, STORAGE_KEY).equals(plaintext)).toBe(true);
  });

  it("stored object is [version 1][12 byte IV][ciphertext][16 byte tag] and hides the plaintext", () => {
    const object = encryptPrivateFile(plaintext, key, STORAGE_KEY);
    expect(object[0]).toBe(1);
    expect(object.length).toBe(1 + 12 + plaintext.length + 16);
    expect(object.includes(plaintext.subarray(0, 8))).toBe(false);
    expect(object.includes(Buffer.from("dummy document"))).toBe(false);
  });

  it("uses a fresh IV for every file", () => {
    const a = encryptPrivateFile(plaintext, key, STORAGE_KEY);
    const b = encryptPrivateFile(plaintext, key, STORAGE_KEY);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("a flipped byte in the IV, the ciphertext or the tag fails", () => {
    const object = encryptPrivateFile(plaintext, key, STORAGE_KEY);
    for (const position of [1, 12, 13, 13 + 5, object.length - 17, object.length - 16, object.length - 1]) {
      const tampered = Buffer.from(object);
      tampered[position] = tampered[position]! ^ 0x01;
      expect(() => decryptPrivateFile(tampered, key, STORAGE_KEY), `byte ${position}`).toThrow(PrivateFileDecryptError);
    }
  });

  it("a wrong key fails", () => {
    const object = encryptPrivateFile(plaintext, key, STORAGE_KEY);
    expect(() => decryptPrivateFile(object, randomBytes(32), STORAGE_KEY)).toThrow(PrivateFileDecryptError);
  });

  it("an object moved to another storage key fails", () => {
    const object = encryptPrivateFile(plaintext, key, STORAGE_KEY);
    const otherKey = "kyb/unassigned/0199a1b2-c3d4-7e5f-8a9b-ffffffffffff";
    expect(() => decryptPrivateFile(object, key, otherKey)).toThrow(PrivateFileDecryptError);
  });

  it("an unknown format version, a truncated or an empty object fails", () => {
    const object = encryptPrivateFile(plaintext, key, STORAGE_KEY);
    const wrongVersion = Buffer.from(object);
    wrongVersion[0] = 2;
    expect(() => decryptPrivateFile(wrongVersion, key, STORAGE_KEY)).toThrow("unknown format version");
    expect(() => decryptPrivateFile(object.subarray(0, object.length - 1), key, STORAGE_KEY)).toThrow(PrivateFileDecryptError);
    expect(() => decryptPrivateFile(object.subarray(0, 20), key, STORAGE_KEY)).toThrow("too short");
    expect(() => decryptPrivateFile(Buffer.alloc(0), key, STORAGE_KEY)).toThrow("too short");
  });

  it("refuses to work with a key that is not 32 bytes", () => {
    expect(() => encryptPrivateFile(plaintext, randomBytes(16), STORAGE_KEY)).toThrow("32 bytes");
    expect(() => decryptPrivateFile(Buffer.alloc(40), randomBytes(31), STORAGE_KEY)).toThrow("32 bytes");
  });
});

describe("PRIVATE_FILES_KEY", () => {
  it("accepts base64 of exactly 32 bytes", () => {
    const encoded = randomBytes(32).toString("base64");
    expect(getPrivateFilesKey({ PRIVATE_FILES_KEY: encoded }).length).toBe(32);
  });

  it("refuses a missing, short, long or non-base64 key, without echoing it", () => {
    expect(() => getPrivateFilesKey({})).toThrow("PRIVATE_FILES_KEY is not set");
    for (const bad of [
      randomBytes(16).toString("base64"),
      randomBytes(33).toString("base64"),
      "not base64 at all !!",
      randomBytes(32).toString("hex"),
    ]) {
      let message = "";
      try {
        getPrivateFilesKey({ PRIVATE_FILES_KEY: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("[Files] PRIVATE_FILES_KEY must be base64 of exactly 32 bytes");
      expect(message).not.toContain(bad);
    }
  });
});

describe("storage configuration", () => {
  const full = {
    S3_ENDPOINT: "https://storage.example",
    S3_REGION: "region-1",
    S3_BUCKET: "bucket-dev",
    S3_ACCESS_KEY_ID: "access-id",
    S3_SECRET_ACCESS_KEY: "secret-value",
  };

  it("without APP_ENV it throws and never falls back to the local store", () => {
    let result: unknown;
    let message = "";
    try {
      result = getS3Config({});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(result).toBeUndefined();
    expect(message).toBe("[Files] APP_ENV is not set");
    expect(() => getS3Config({ APP_ENV: "" })).toThrow("[Files] APP_ENV is not set");
    // An unset APP_ENV must not be rescued by complete S3 settings either.
    expect(() => getS3Config({ ...full })).toThrow("[Files] APP_ENV is not set");
    expect(() => getS3Config({ APP_ENV: "staging", ...full })).toThrow();
  });

  it("local falls back to the local s3mock", () => {
    expect(getS3Config({ APP_ENV: "local" })).toMatchObject({
      endpoint: "http://127.0.0.1:9090",
      bucket: "cherrio-private-local",
    });
  });

  it("dev/uat/prod need every variable; the error names variables, not values", () => {
    expect(getS3Config({ APP_ENV: "dev", ...full }).bucket).toBe("bucket-dev");
    for (const appEnv of ["dev", "uat", "prod"]) {
      expect(() => getS3Config({ APP_ENV: appEnv })).toThrow(
        "Missing storage configuration: S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY"
      );
    }
    let message = "";
    try {
      getS3Config({ APP_ENV: "dev", ...full, S3_BUCKET: undefined });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("[Files] Missing storage configuration: S3_BUCKET");
    expect(message).not.toContain("secret-value");
  });
});
