import { ORGANIZATION_CAUSES } from "@cherrio/shared/organizations";
import { CAMPAIGN_SORTS } from "@/lib/campaigns/filter-options";
import { MARKET_CAP_ON, MARKET_CAP_SORTS } from "@/lib/market-cap/list";

// OpenAPI 3.1 description of the public read API v1 (TASK-018b), served at
// /api/v1/openapi.json and rendered on /en/docs/api. Kept next to the code it
// describes; `api-v1.test.ts` checks real responses against these schemas.

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;
const usdc = { type: "string", pattern: "^[0-9]+$", description: "USDC base units (6 decimals) as a string." } as const;

const OrganizationSummary = {
  type: "object",
  required: ["id", "position", "name", "country", "causes", "trustScore", "onCherrio", "raisedUsdc", "url"],
  properties: {
    id: { type: "string", format: "uuid" },
    position: { type: "integer", description: "Position in this list (the overall rank when no filter or search is used)." },
    name: str,
    country: { ...nullableStr, description: "ISO 3166-1 alpha-2" },
    causes: { type: "array", items: { type: "string", enum: [...ORGANIZATION_CAUSES] } },
    trustScore: { type: "string", pattern: "^[0-9]{1,3}\\.[0-9]{2}$", description: "0–100, two decimals." },
    onCherrio: { type: "boolean", description: "Verified on CHERR.IO; otherwise imported from a public register (score at most 40)." },
    raisedUsdc: usdc,
    url: { type: "string", format: "uri" },
  },
} as const;

const OrganizationDetail = {
  type: "object",
  required: ["id", "name", "country", "causes", "onCherrio", "claimable", "trustScore", "ratings", "raisedUsdc", "register", "url"],
  properties: {
    id: { type: "string", format: "uuid" },
    name: str,
    country: str,
    causes: { type: "array", items: str },
    website: nullableStr,
    description: nullableStr,
    onCherrio: { type: "boolean" },
    claimable: { type: "boolean" },
    trustScore: {
      type: "object",
      required: ["score", "version", "components", "computedAt"],
      properties: {
        score: str,
        version: { type: "integer" },
        components: { type: "object", description: "The parts of the score (see /en/charity-market-cap/methodology)." },
        computedAt: { type: "string", format: "date-time" },
      },
    },
    ratings: { type: "object", required: ["average", "count"], properties: { average: { type: ["number", "null"] }, count: { type: "integer" } } },
    raisedUsdc: usdc,
    register: {
      type: ["object", "null"],
      properties: { name: str, id: nullableStr, facts: { type: "object", description: "What the public register says; never contact details." } },
    },
    url: { type: "string", format: "uri" },
  },
} as const;

const CampaignSummary = {
  type: "object",
  required: ["id", "slug", "title", "organization", "cause", "country", "target", "deadline", "contract", "demo", "state", "raisedUsdc", "donors", "url"],
  properties: {
    id: { type: "string", format: "uuid" },
    slug: str,
    title: str,
    organization: { type: "object", properties: { id: str, name: str, verified: { type: "boolean" } } },
    cause: str,
    country: str,
    target: { type: "object", properties: { eurCents: { type: "string", pattern: "^[0-9]+$" }, usdc } },
    deadline: { type: "string", format: "date-time" },
    contract: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "The campaign's escrow contract on Polygon." },
    demo: { type: "boolean", description: "A made-up campaign for testing (dev only)." },
    state: { type: ["string", "null"], description: "live, ending, succeeded, completed, failed, …; null when chain data is unavailable." },
    raisedUsdc: { type: ["string", "null"], pattern: "^[0-9]+$" },
    donors: { type: ["integer", "null"] },
    payoutMode: { type: ["string", "null"], enum: ["SINGLE", "MILESTONES", null] },
    url: { type: "string", format: "uri" },
  },
} as const;

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object", required: ["error"], properties: { error: str } } } },
});
const q = (name: string, description: string, schema: object = str) => ({ name, in: "query", required: false, description, schema });

export function openApiDocument(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "CHERR.IO public API",
      version: "1.0.0",
      description:
        "Read-only data about campaigns and the Charity Market Cap. No login. Money is a string of base units (USDC has 6 decimals). Limit: 120 requests per minute per IP; then 429 with Retry-After.",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: `${origin}/api/v1` }],
    paths: {
      "/organizations": {
        get: {
          summary: "Charity Market Cap: organisations by Trust Score",
          parameters: [
            q("q", "Search by name."),
            q("country", "ISO 3166-1 alpha-2."),
            q("cause", "One cause.", { type: "string", enum: [...ORGANIZATION_CAUSES] }),
            q("on", "On CHERR.IO or only in a public register.", { type: "string", enum: [...MARKET_CAP_ON] }),
            q("sort", "Order (default score).", { type: "string", enum: [...MARKET_CAP_SORTS] }),
            q("limit", "1–100, default 25.", { type: "integer", minimum: 1, maximum: 100 }),
            q("after", "Cursor: `next` of the previous page."),
          ],
          responses: {
            "200": {
              description: "One page.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["data", "next", "nextUrl"],
                    properties: { data: { type: "array", items: OrganizationSummary }, next: nullableStr, nextUrl: nullableStr },
                  },
                },
              },
            },
            "429": errorResponse("Too many requests."),
          },
        },
      },
      "/organizations/{id}": {
        get: {
          summary: "One organisation with its Trust Score parts, ratings and register facts",
          parameters: [{ name: "id", in: "path", required: true, description: "The organisation id (`id` in the list).", schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": { description: "The organisation.", content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: OrganizationDetail } } } } },
            "404": errorResponse("Not listed or unknown."),
            "429": errorResponse("Too many requests."),
          },
        },
      },
      "/campaigns": {
        get: {
          summary: "Published campaigns",
          parameters: [
            q("cause", "Cause; repeat for several."),
            q("country", "ISO 3166-1 alpha-2; repeat for several."),
            q("q", "Search title and organisation name."),
            q("sort", "Order (live campaigns first in every order).", { type: "string", enum: [...CAMPAIGN_SORTS] }),
            q("page", "Page, 24 per page.", { type: "integer", minimum: 1 }),
          ],
          responses: {
            "200": {
              description: "One page.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["data", "page", "pageCount", "total", "chainAvailable"],
                    properties: {
                      data: { type: "array", items: CampaignSummary },
                      page: { type: "integer" },
                      pageCount: { type: "integer" },
                      total: { type: "integer" },
                      chainAvailable: { type: "boolean" },
                    },
                  },
                },
              },
            },
            "429": errorResponse("Too many requests."),
          },
        },
      },
      "/campaigns/{slug}": {
        get: {
          summary: "One published campaign with its story",
          parameters: [{ name: "slug", in: "path", required: true, description: "The campaign slug (`slug` in the list).", schema: str }],
          responses: {
            "200": {
              description: "The campaign.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["data"],
                    properties: { data: { allOf: [CampaignSummary, { type: "object", required: ["story"], properties: { story: str } }] } },
                  },
                },
              },
            },
            "404": errorResponse("Not published or unknown."),
            "429": errorResponse("Too many requests."),
          },
        },
      },
    },
  };
}
