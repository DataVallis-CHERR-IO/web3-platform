import { getAddress, isAddress } from "viem";
import { z } from "zod";

// Organisation application (TASK-008b): what a charity submits to be verified.
// The same schema validates the form in the browser and the API on the server.

/** Mirrors the `registry_type` enum in @cherrio/db (a test keeps them equal). */
export const ORGANIZATION_REGISTRIES = ["SI_AJPES", "SI_MJU", "UK_CC", "US_IRS", "NONE"] as const;

/** Fixed list of causes; the middle four are the emergency sub-pool themes. */
export const ORGANIZATION_CAUSES = [
  "humanitarian",
  "medical",
  "disasters",
  "animals",
  "climate",
  "children",
  "education",
  "poverty",
  "community",
] as const;
export type OrganizationCause = (typeof ORGANIZATION_CAUSES)[number];

/** ISO 3166-1 alpha-2 country codes (249). */
export const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
  "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

/** The EIP-55 (mixed-case, checksummed) form of a stored lowercase address, for display. */
export function checksumAddress(address: string): string {
  return isAddress(address) ? getAddress(address) : address;
}

/** Mirrors the `private_file_kind` enum; how many documents of each kind one application carries. */
export const KYB_DOCUMENT_RULES = {
  KYB_REGISTRATION_EXTRACT: { min: 1, max: 1 },
  KYB_AUTHORISATION: { min: 1, max: 1 },
  KYB_STATUTE: { min: 0, max: 1 },
  KYB_OTHER: { min: 0, max: 2 },
} as const;
export type KybDocumentKind = keyof typeof KYB_DOCUMENT_RULES;

/** True when the kinds of the attached documents satisfy KYB_DOCUMENT_RULES. */
export function kybDocumentsComplete(kinds: readonly string[]): boolean {
  if (kinds.some((kind) => !(kind in KYB_DOCUMENT_RULES))) return false;
  return (Object.keys(KYB_DOCUMENT_RULES) as KybDocumentKind[]).every((kind) => {
    const n = kinds.filter((k) => k === kind).length;
    return n >= KYB_DOCUMENT_RULES[kind].min && n <= KYB_DOCUMENT_RULES[kind].max;
  });
}

const name = z.string().trim().min(2).max(200);
const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const applicationFields = z
  .object({
    name,
    legalName: name,
    country: z.string().refine((code) => COUNTRY_CODES.includes(code)),
    registry: z.enum(ORGANIZATION_REGISTRIES),
    registryId: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(64).optional()),
    website: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .max(200)
        .url()
        .refine((url) => url.startsWith("https://"))
        .optional()
    ),
    description: z.string().trim().min(1).max(1000),
    causes: z
      .array(z.enum(ORGANIZATION_CAUSES))
      .min(1)
      .max(5)
      .refine((causes) => new Set(causes).size === causes.length),
    /** A valid EVM address; a mixed-case value must have a correct checksum. Stored lowercase. */
    payoutAddress: z
      .string()
      .trim()
      .refine((address) => isAddress(address))
      .transform((address) => address.toLowerCase()),
    fileIds: z
      .array(z.string().uuid())
      .min(2)
      .max(5)
      .refine((ids) => new Set(ids).size === ids.length),
    /** Only for "Submit again": the rejected organisation this application belongs to. */
    organizationId: z.string().uuid().optional(),
  });

export const organizationApplicationSchema = applicationFields
  .superRefine((value, ctx) => {
    if (value.registry === "NONE" && value.registryId !== undefined) {
      ctx.addIssue({ code: "custom", path: ["registryId"], message: "must be empty when there is no registry" });
    }
    if (value.registry !== "NONE" && value.registryId === undefined) {
      ctx.addIssue({ code: "custom", path: ["registryId"], message: "required for this registry" });
    }
  });

export type OrganizationApplication = z.infer<typeof organizationApplicationSchema>;

/**
 * The part of an application that is stored with the submission and, on
 * approval, applied to the organisation: no file ids, nothing about the applicant.
 */
export const organizationApplicationDataSchema = applicationFields.omit({
  fileIds: true,
  registry: true,
  registryId: true,
  organizationId: true,
});
export type OrganizationApplicationData = z.infer<typeof organizationApplicationDataSchema>;
