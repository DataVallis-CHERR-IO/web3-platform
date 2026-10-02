import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { S3Config } from "./config";

/** The few storage operations private files need; tests use an in-memory one. */
export interface ObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  /** Null when the object does not exist. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<{ key: string; lastModified: Date | undefined }[]>;
  /** Throws if the bucket is missing or not reachable. */
  check(): Promise<void>;
}

/** S3 API client for Hetzner Object Storage (and the local s3mock). */
export function createS3ObjectStore(config: S3Config): ObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // S3-compatible stores: path-style URLs, and no SDK-added checksums
    // (newer SDK defaults that some non-AWS stores reject).
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const Bucket = config.bucket;

  return {
    async put(key, body) {
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: "application/octet-stream" })
      );
    },
    async get(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!result.Body) return null;
        return Buffer.from(await result.Body.transformToByteArray());
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name === "NoSuchKey" || name === "NotFound") return null;
        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async list(prefix) {
      const objects: { key: string; lastModified: Date | undefined }[] = [];
      let ContinuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }));
        for (const item of page.Contents ?? []) {
          if (item.Key) objects.push({ key: item.Key, lastModified: item.LastModified });
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return objects;
    },
    async check() {
      await client.send(new HeadBucketCommand({ Bucket }));
    },
  };
}
