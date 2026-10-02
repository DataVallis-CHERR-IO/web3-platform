import { pgSchema } from "drizzle-orm/pg-core";

export const appSchema = pgSchema("app");

// ── User / auth ─────────────────────────────────────────────────────────────
export const addressKindEnum = appSchema.enum("address_kind", [
  "EMBEDDED",
  "SMART_ACCOUNT",
  "EXTERNAL",
]);

export const platformRoleEnum = appSchema.enum("platform_role", [
  "PLATFORM_ADMIN",
]);

// ── Organisation ─────────────────────────────────────────────────────────────
export const orgSourceEnum = appSchema.enum("org_source", [
  "REGISTERED",
  "IMPORTED",
]);

export const registryTypeEnum = appSchema.enum("registry_type", [
  "SI_AJPES",
  "SI_MJU",
  "UK_CC",
  "US_IRS",
  "NONE",
]);

export const kybStatusEnum = appSchema.enum("kyb_status", [
  "NONE",
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export const kybSubmissionStatusEnum = appSchema.enum("kyb_submission_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export const privateFileKindEnum = appSchema.enum("private_file_kind", [
  "KYB_REGISTRATION_EXTRACT",
  "KYB_STATUTE",
  "KYB_AUTHORISATION",
  "KYB_OTHER",
]);

export const orgMemberRoleEnum = appSchema.enum("org_member_role", [
  "ORG_ADMIN",
  "ORG_MEMBER",
]);

// ── KYC ──────────────────────────────────────────────────────────────────────
export const kycStatusEnum = appSchema.enum("kyc_status", [
  "INITIATED",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "RESUBMISSION_REQUESTED",
]);

// ── Campaign ──────────────────────────────────────────────────────────────────
export const beneficiaryTypeEnum = appSchema.enum("beneficiary_type", [
  "ORGANIZATION",
  "INDIVIDUAL",
]);

export const campaignStatusEnum = appSchema.enum("campaign_status", [
  "DRAFT",
  "PENDING_REVIEW",
  "REJECTED",
  "APPROVED",
  "DEPLOYED",
]);

export const mediaKindEnum = appSchema.enum("media_kind", [
  "COVER",
  "GALLERY",
  "VIDEO",
]);

export const storageProviderEnum = appSchema.enum("storage_provider", [
  "POLLINATIONX",
  "PINATA",
]);

export const evidenceStatusEnum = appSchema.enum("evidence_status", [
  "DRAFT",
  "SUBMITTED_ONCHAIN",
  "VOTING",
  "APPROVED",
  "REJECTED",
]);

// ── Points / levels ───────────────────────────────────────────────────────────
export const pointBucketEnum = appSchema.enum("point_bucket", [
  "STATUS",
  "REWARD",
]);

export const pointReasonEnum = appSchema.enum("point_reason", [
  "REGISTRATION",
  "DONATION",
  "RATING",
  "VOTE",
  "KYC_PASSED",
  "KYB_REFERRAL",
  "ADMIN_ADJUSTMENT",
]);

// ── Onramp ────────────────────────────────────────────────────────────────────
export const onrampProviderEnum = appSchema.enum("onramp_provider", [
  "TRANSAK",
]);

export const onrampStatusEnum = appSchema.enum("onramp_status", [
  "PENDING",
  "COMPLETED",
  "FAILED",
  "REFUNDED",
  "CANCELLED",
  "EXPIRED",
]);
