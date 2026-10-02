// Upload checks for private files: type by magic bytes, never by the browser's
// Content-Type or file name. Only PDF, JPEG and PNG, at most 10 MB.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface DetectedFileType {
  mimeType: "application/pdf" | "image/jpeg" | "image/png";
  extension: "pdf" | "jpg" | "png";
}

const SIGNATURES: { bytes: number[]; type: DetectedFileType }[] = [
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], type: { mimeType: "application/pdf", extension: "pdf" } }, // %PDF-
  { bytes: [0xff, 0xd8, 0xff], type: { mimeType: "image/jpeg", extension: "jpg" } },
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    type: { mimeType: "image/png", extension: "png" },
  },
];

export type FileRejectionCode = "file_empty" | "file_too_large" | "file_type_not_allowed";

/** A file the user sent is not acceptable; `code` maps to a next-intl message. */
export class FileRejectedError extends Error {
  constructor(public readonly code: FileRejectionCode) {
    super(code);
    this.name = "FileRejectedError";
  }
}

export function detectFileType(bytes: Uint8Array): DetectedFileType | null {
  for (const { bytes: signature, type } of SIGNATURES) {
    if (bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b)) return type;
  }
  return null;
}

/** Size and type check; returns the detected type or throws FileRejectedError. */
export function checkUpload(bytes: Uint8Array): DetectedFileType {
  if (bytes.length === 0) throw new FileRejectedError("file_empty");
  if (bytes.length > MAX_FILE_BYTES) throw new FileRejectedError("file_too_large");
  const type = detectFileType(bytes);
  if (!type) throw new FileRejectedError("file_type_not_allowed");
  return type;
}
