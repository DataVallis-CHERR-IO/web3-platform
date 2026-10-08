import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getS3Config } from "@/lib/files/config";
import { getPublicMediaConfig, publicObjectStore } from "@/lib/media/public-store";

// Stored link previews (TASK-059): a campaign preview is static, so it is
// rendered once per content and kept in the public bucket under `og/` (outside
// the `campaigns/` prefix the media sweep owns). The key is a hash of what the
// image shows, so a new title, cover or outcome gives a new object and the old
// one is simply no longer read. Storage problems never break the preview: it is
// then rendered on the fly.

/** Bump when the design changes, so every preview is rendered again. */
export const OG_DESIGN_VERSION = 1;

export function ogStoreKey(campaignId: string, content: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify([OG_DESIGN_VERSION, content])).digest("hex").slice(0, 24);
  return `og/${campaignId}/${hash}.png`;
}

export async function readStoredOg(key: string): Promise<Buffer | null> {
  try {
    return await publicObjectStore().get(key);
  } catch {
    return null;
  }
}

let client: S3Client | undefined;

export async function storeOg(key: string, png: Buffer): Promise<boolean> {
  try {
    const config = getS3Config();
    client ??= new S3Client({
      endpoint: config.endpoint, region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    });
    await client.send(new PutObjectCommand({
      Bucket: getPublicMediaConfig().bucket, Key: key, Body: png, ContentType: "image/png",
      // The key changes with the content, so the object never changes.
      CacheControl: "public, max-age=31536000, immutable", ACL: "public-read",
    }));
    return true;
  } catch (error) {
    console.warn(`[og] preview not stored (${error instanceof Error ? error.name : "unknown"})`);
    return false;
  }
}
