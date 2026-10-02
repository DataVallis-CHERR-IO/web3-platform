import { NextResponse } from "next/server";

/**
 * Every error the file routes can return. The response carries only the code;
 * the text shown to the user is the next-intl message `files.errors.<code>`.
 */
export const FILES_ERROR_CODES = [
  "forbidden",
  "unauthorized",
  "rate_limited",
  "length_required",
  "busy",
  "bad_request",
  "file_empty",
  "file_too_large",
  "file_type_not_allowed",
  "too_many_files",
  "not_found",
  "file_attached",
] as const;

export type FilesErrorCode = (typeof FILES_ERROR_CODES)[number];

export function filesError(code: FilesErrorCode, status: number, headers?: Record<string, string>) {
  return NextResponse.json({ error: code }, { status, headers });
}
