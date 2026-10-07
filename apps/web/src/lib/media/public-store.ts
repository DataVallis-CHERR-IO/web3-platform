import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parseAppEnv } from "@cherrio/shared";
import { getS3Config } from "@/lib/files/config";
import { createS3ObjectStore, type ObjectStore } from "@/lib/files/s3";

// Public campaign media (ADR-037): a public bucket per environment, read by
// its public URL. Only non-personal content; object keys are random.
// Same storage account and credentials as the private bucket, another bucket.

/** docker-compose.dev.yml service `s3mock`. */
const LOCAL = { bucket: "cherrio-public-local", baseUrl: "http://127.0.0.1:9090/cherrio-public-local" };

export function getPublicMediaConfig(env: Record<string, string | undefined> = process.env) {
  if (!env.APP_ENV) throw new Error("[Media] APP_ENV is not set");
  const isLocal = parseAppEnv(env.APP_ENV) === "local";
  const bucket = env.S3_PUBLIC_BUCKET || (isLocal ? LOCAL.bucket : undefined);
  const baseUrl = env.S3_PUBLIC_BASE_URL || (isLocal ? LOCAL.baseUrl : undefined);
  const missing = [!bucket && "S3_PUBLIC_BUCKET", !baseUrl && "S3_PUBLIC_BASE_URL"].filter(Boolean);
  if (!bucket || !baseUrl) throw new Error(`[Media] Missing storage configuration: ${missing.join(", ")}`);
  return { bucket, baseUrl: baseUrl.replace(/\/+$/, "") };
}

/** The public URL of a stored object (`campaign_media.cid` holds the key). */
export function publicMediaUrl(key: string): string {
  return `${getPublicMediaConfig().baseUrl}/${key}`;
}

let client: S3Client | undefined;
function s3(): S3Client {
  if (!client) {
    const config = getS3Config();
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
}

export async function putPublicImage(key: string, webp: Buffer): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: getPublicMediaConfig().bucket,
      Key: key,
      Body: webp,
      ContentType: "image/webp",
      // Keys are random and never reused, so the object can be cached for good.
      CacheControl: "public, max-age=31536000, immutable",
      ACL: "public-read",
    })
  );
}

/**
 * A public PDF (ADR-039), stored unchanged. Shown inline in the browser; the
 * download name is fixed so no user-supplied text goes into a header.
 */
export async function putPublicPdf(key: string, pdf: Buffer): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: getPublicMediaConfig().bucket,
      Key: key,
      Body: pdf,
      ContentType: "application/pdf",
      ContentDisposition: 'inline; filename="document.pdf"',
      CacheControl: "public, max-age=31536000, immutable",
      ACL: "public-read",
    })
  );
}

/** Deletes a replaced object. A failure is logged without the key; the object stays as a public orphan. */
export async function removePublicObject(key: string): Promise<boolean> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: getPublicMediaConfig().bucket, Key: key }));
    return true;
  } catch (error) {
    console.warn(`[Media] public object delete failed (${error instanceof Error ? error.name : "unknown"})`);
    return false;
  }
}

/** The public bucket as an `ObjectStore` (list/delete for `files:sweep`, TASK-052). */
export function publicObjectStore(): ObjectStore {
  return createS3ObjectStore({ ...getS3Config(), bucket: getPublicMediaConfig().bucket });
}
