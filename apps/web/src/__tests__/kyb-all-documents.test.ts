import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { applicationRateLimiter } from "@/lib/security/rate-limit";
import { cleanUp, createFiles, createUser, submit } from "./helpers/organizations";

// David (dev test 2026-10-02): the admin page listed extract, authorisation and
// statute, but not the optional "other" documents. This proves that all five
// document slots of the form are attached to the submission, which is exactly
// what the admin page lists (private_files by kyb_submission_id, not deleted).

const { privateFiles } = schema;

async function file(userId: string, kind: "KYB_STATUTE" | "KYB_OTHER") {
  const id = schema.newId();
  await getDb().insert(privateFiles).values({
    id, storageKey: `kyb/unassigned/${id}`, kind, mimeType: "application/pdf", sizeBytes: 999, sha256: "cd".repeat(32), uploadedBy: userId,
  });
  return id;
}

describe("KYB application with every optional document (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("this test needs DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await getDb().execute(sql`select 1`);
    applicationRateLimiter.reset();
  });
  afterAll(cleanUp);

  it("extract + authorisation + statute + two others are all attached and listed for the reviewer", async () => {
    const applicant = await createUser();
    const required = await createFiles(applicant.id);
    const optional = [await file(applicant.id, "KYB_STATUTE"), await file(applicant.id, "KYB_OTHER"), await file(applicant.id, "KYB_OTHER")];
    const sent = await submit(applicant, { fileIds: [...required, ...optional] });
    expect(sent.status).toBe(201);

    const listed = await getDb()
      .select({ kind: privateFiles.kind })
      .from(privateFiles)
      .where(and(eq(privateFiles.kybSubmissionId, sent.submissionId!), isNull(privateFiles.deletedAt)));
    expect(listed.map((f) => f.kind).sort()).toEqual(
      ["KYB_AUTHORISATION", "KYB_OTHER", "KYB_OTHER", "KYB_REGISTRATION_EXTRACT", "KYB_STATUTE"]
    );
  });
});
