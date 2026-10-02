import { char, check, index, integer, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, privateFileKindEnum } from "./enums.js";
import { uuidPk } from "./helpers.js";
import { kybSubmissions } from "./organizations.js";
import { users } from "./users.js";

// ── private_files ─────────────────────────────────────────────────────────────
// One row per encrypted object in private storage (ADR-033). The row holds no
// file name and no personal data; `storage_key` is `kyb/<orgId|unassigned>/<id>`.
// The key is bound into the encryption (GCM additional data): it must never
// change after upload, or the object can no longer be decrypted.
export const privateFiles = appSchema.table("private_files", {
  id:              uuidPk(),
  storageKey:      text("storage_key").notNull().unique(),
  kind:            privateFileKindEnum("kind").notNull(),
  /** From the magic-byte check on the server, never from the browser. */
  mimeType:        text("mime_type").notNull(),
  /** Size of the plaintext. */
  sizeBytes:       integer("size_bytes").notNull(),
  /** SHA-256 of the plaintext, lowercase hex. */
  sha256:          char("sha256", { length: 64 }).notNull(),
  /** Which PRIVATE_FILES_KEY encrypted the object (for a future rotation). */
  keyVersion:      smallint("key_version").notNull().default(1),
  uploadedBy:      uuid("uploaded_by").notNull().references(() => users.id),
  /** Null until the application is submitted. */
  kybSubmissionId: uuid("kyb_submission_id").references(() => kybSubmissions.id),
  /** Set when the stored object has been deleted. */
  deletedAt:       timestamp("deleted_at", { withTimezone: true }),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("private_files_uploaded_by_idx").on(t.uploadedBy),
  index("private_files_kyb_submission_id_idx").on(t.kybSubmissionId),
  check("private_files_size_bytes_check", sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 10485760`),
  check("private_files_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
]);
