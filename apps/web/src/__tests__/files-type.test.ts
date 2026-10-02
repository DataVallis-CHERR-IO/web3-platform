import { describe, expect, it } from "vitest";
import { checkUpload, detectFileType, FileRejectedError, MAX_FILE_BYTES } from "@/lib/files/file-type";

// Generated dummy content only — no real documents in the repo.
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< >>\nendobj\n%%EOF");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function rejection(bytes: Uint8Array): string {
  try {
    checkUpload(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(FileRejectedError);
    return (error as FileRejectedError).code;
  }
  return "accepted";
}

describe("file type by magic bytes", () => {
  it("accepts PDF, JPEG and PNG and names the type itself", () => {
    expect(checkUpload(pdf)).toEqual({ mimeType: "application/pdf", extension: "pdf" });
    expect(checkUpload(jpeg)).toEqual({ mimeType: "image/jpeg", extension: "jpg" });
    expect(checkUpload(png)).toEqual({ mimeType: "image/png", extension: "png" });
  });

  it("refuses an HTML file renamed to .pdf, and other types", () => {
    expect(rejection(Buffer.from("<!doctype html><html><script>alert(1)</script></html>"))).toBe("file_type_not_allowed");
    expect(rejection(Buffer.from("PK\u0003\u0004 zip or docx"))).toBe("file_type_not_allowed");
    expect(rejection(Buffer.from("GIF89a"))).toBe("file_type_not_allowed");
    expect(rejection(Buffer.from("MZ executable"))).toBe("file_type_not_allowed");
    expect(rejection(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe("file_type_not_allowed");
  });

  it("refuses a signature that is not at the very start, or is incomplete", () => {
    expect(detectFileType(Buffer.from(" %PDF-1.7"))).toBeNull();
    expect(detectFileType(Buffer.from("%PDF"))).toBeNull();
    expect(detectFileType(png.subarray(0, 7))).toBeNull();
    expect(detectFileType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it("enforces the size limit: 10 MB passes, one byte more does not, empty does not", () => {
    const atLimit = Buffer.alloc(MAX_FILE_BYTES);
    pdf.copy(atLimit);
    expect(rejection(atLimit)).toBe("accepted");

    const overLimit = Buffer.alloc(MAX_FILE_BYTES + 1);
    pdf.copy(overLimit);
    expect(rejection(overLimit)).toBe("file_too_large");

    expect(rejection(Buffer.alloc(0))).toBe("file_empty");
  });
});
