import sharp from "sharp";
import { FileRejectedError } from "@/lib/files/file-type";

// Cover images (ADR-037): JPEG, PNG or WebP by magic bytes, at most 5 MB, and
// always re-encoded on the server. The re-encode writes no metadata, so EXIF
// (camera, date, GPS position) never reaches the public bucket.

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_WIDTH = 1600;
/** Refuses "decompression bombs": a small file that expands to a huge bitmap. */
const MAX_INPUT_PIXELS = 40_000_000;

// One image at a time per process: the web container is small.
sharp.concurrency(1);
sharp.cache(false);

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

export function isAllowedImage(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0xff, 0xd8, 0xff]) || // JPEG
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || // PNG
    (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) // RIFF….WEBP
  );
}

/**
 * Checks the upload and returns it as WebP, at most 1600 px wide, without any
 * metadata. Throws FileRejectedError for a file the user must not upload.
 */
export async function processCoverImage(bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0) throw new FileRejectedError("file_empty");
  if (bytes.length > MAX_IMAGE_BYTES) throw new FileRejectedError("file_too_large");
  if (!isAllowedImage(bytes)) throw new FileRejectedError("file_type_not_allowed");
  try {
    return await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate() // apply the EXIF orientation before the tag is dropped
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    // Right signature, but not an image we can decode (damaged, or too many pixels).
    throw new FileRejectedError("file_type_not_allowed");
  }
}
