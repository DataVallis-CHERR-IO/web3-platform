import type { Database } from "@cherrio/db";
import { ORGANIZATION_CAUSES } from "@cherrio/shared/organizations";
import { TRUST_SCORE_VERSION } from "@cherrio/shared/trust";
import { campaignDetail, campaignSummary, organizationDetail, organizationSummary } from "@/lib/api/v1";
import { CAMPAIGN_SORTS, parseCampaignSort } from "@/lib/campaigns/filter-options";
import { getPublicCampaign, listPublicCampaigns, parseCampaignFilters } from "@/lib/campaigns/public";
import { listMarketCap, MARKET_CAP_SORTS, parseMarketCapQuery } from "@/lib/market-cap/list";
import { getMarketCapProfile } from "@/lib/market-cap/profile";
import { orgRatingSummaries } from "@/lib/ratings";
import { llmsTxt } from "@/lib/seo/llms";

// Read-only MCP server (TASK-020) over Streamable HTTP, stateless: every POST
// carries one JSON-RPC message and gets one JSON answer (no sessions, no SSE).
// The tools read the same public data as the REST API (TASK-018b); nothing
// here writes, signs or reads anything personal.

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SERVER_INFO = { name: "cherrio", title: "CHERR.IO", version: "1.0.0" };

type Json = Record<string, unknown>;
interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Json;
}
export type RpcResponse = { jsonrpc: "2.0"; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

const err = (id: RpcResponse["id"], code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

export const TOOLS = [
  {
    name: "search_charities",
    title: "Search the Charity Market Cap",
    description:
      "Charities ranked by their public Trust Score (0–100): organisations verified on CHERR.IO and charities from public registers (England and Wales, US 501(c)(3)). Filter by name, country, cause or whether they are on CHERR.IO; pages with a cursor.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of the name." },
        country: { type: "string", description: "ISO 3166-1 alpha-2, e.g. GB, US, SI." },
        cause: { type: "string", enum: [...ORGANIZATION_CAUSES] },
        on_cherrio: { type: "boolean", description: "true: only verified on CHERR.IO; false: only from public registers." },
        sort: { type: "string", enum: [...MARKET_CAP_SORTS], description: "Default score." },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "Default 10." },
        cursor: { type: "string", description: "`next` of the previous result." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_charity",
    title: "One charity",
    description: "A charity's Trust Score with its parts, donor ratings, money raised on CHERR.IO and what its public register says.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The `id` from search_charities." } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_campaigns",
    title: "Fundraising campaigns",
    description: "Published campaigns on CHERR.IO with goal, progress, donors and deadline. Live campaigns come first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words in the title or organisation name." },
        cause: { type: "string", enum: [...ORGANIZATION_CAUSES] },
        country: { type: "string", description: "ISO 3166-1 alpha-2." },
        sort: { type: "string", enum: [...CAMPAIGN_SORTS], description: "Default ending (soonest deadline first)." },
        page: { type: "integer", minimum: 1, description: "24 per page." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_campaign",
    title: "One campaign",
    description: "A campaign's story, goal, progress, donors, deadline, payout mode and its escrow contract on Polygon.",
    inputSchema: { type: "object", properties: { slug: { type: "string", description: "The `slug` from list_campaigns." } }, required: ["slug"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "trust_score_methodology",
    title: "How the Trust Score works",
    description: `The published method of Trust Score v${TRUST_SCORE_VERSION}: parts, weights, the cap for charities from public registers, and data sources.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data });
const toolError = (message: string) => ({ content: [{ type: "text", text: message }], isError: true });

async function callTool(db: Database, origin: string, name: string, args: Json) {
  switch (name) {
    case "search_charities": {
      const on = args.on_cherrio === true ? "cherrio" : args.on_cherrio === false ? "other" : undefined;
      const query = parseMarketCapQuery({ q: str(args.query, 100), country: str(args.country, 2), cause: str(args.cause), on, sort: str(args.sort), after: str(args.cursor, 600) });
      const limit = Math.min(25, Math.max(1, Number.isInteger(args.limit) ? (args.limit as number) : 10));
      const { rows, next } = await listMarketCap(db, query, limit);
      return ok({ charities: rows.map((r) => organizationSummary(r, origin)), next });
    }
    case "get_charity": {
      const id = str(args.id, 64);
      const profile = id ? await getMarketCapProfile(db, id) : null;
      if (!profile) return toolError("No listed charity with this id. Use search_charities to find one.");
      const ratings = await orgRatingSummaries(db, [profile.id]);
      return ok(organizationDetail(profile, ratings.get(profile.id), origin));
    }
    case "list_campaigns": {
      const filters = parseCampaignFilters({ cause: str(args.cause), country: str(args.country, 2), q: str(args.query, 100) });
      const result = await listPublicCampaigns(db, {
        page: Number.isInteger(args.page) ? (args.page as number) : 1,
        sort: parseCampaignSort(str(args.sort)),
        ...filters,
      });
      return ok({ campaigns: result.campaigns.map((c) => campaignSummary(c, origin)), page: result.page, pageCount: result.pageCount, total: result.total });
    }
    case "get_campaign": {
      const slug = str(args.slug, 200);
      const found = slug && /^[a-z0-9-]+$/.test(slug) ? await getPublicCampaign(db, slug) : null;
      if (!found) return toolError("No published campaign with this slug. Use list_campaigns to find one.");
      return ok(campaignDetail(found.campaign, origin));
    }
    case "trust_score_methodology":
      return { content: [{ type: "text", text: `${llmsTxt(origin)}\nFull method: ${origin}/en/charity-market-cap/methodology\n` }] };
    default:
      return null;
  }
}

/** One JSON-RPC message → its answer, or null for a notification (HTTP 202). */
export async function handleMcpMessage(db: Database, origin: string, message: unknown): Promise<RpcResponse | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) return err(null, -32600, "Invalid Request: one JSON-RPC message per POST");
  const m = message as Partial<RpcRequest>;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return err(m.id ?? null, -32600, "Invalid Request");
  const isNotification = m.id === undefined;
  if (isNotification) return null; // notifications/initialized, cancelled, …: nothing to answer
  const id = m.id ?? null;
  const params = (m.params ?? {}) as Json;

  switch (m.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Read-only data from CHERR.IO, a transparent charitable-donation platform on Polygon: charities ranked by Trust Score (search_charities, get_charity), fundraising campaigns (list_campaigns, get_campaign) and the scoring method. Money is in base units (USDC: 6 decimals). Link people to the `url` fields to donate.",
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Json;
      const result = await callTool(db, origin, name, args);
      if (!result) return err(id, -32602, `Unknown tool: ${name}`);
      return { jsonrpc: "2.0", id, result };
    }
    default:
      return err(id, -32601, `Method not found: ${m.method}`);
  }
}
