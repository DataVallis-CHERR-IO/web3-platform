import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { SUCCEEDED_CAMPAIGN_STATES } from "@cherrio/shared/points";
import { TRUST_SCORE_VERSION } from "@cherrio/shared/trust";

// Trust Score v1 (ADR-059, TASK-017a). One set-based pass computes the score of
// every organisation in scope and upserts `trust_scores` rows whose score or
// listing fields changed (one row per organisation and version).
//
// On CHERR.IO (KYB approved): 100 × (0.30 rating + 0.25 success + 0.20 milestones
//   + 0.15 evidence + 0.10 verification), each component 0–1:
//   rating      (5·3.5 + Σstars) / (5 + n) / 5
//   success     reached-threshold / finished campaigns; 0.5 while < 3 finished
//   milestones  donor-approved rounds / donor-decided rounds; 0.5 with none
//   evidence    submitted bundles / released tranches (≤ 1); 0.5 with no release
//   verification 1.0
// Imported (not on CHERR.IO): 20 + 20 × completeness (20–40), completeness = share of
//   active registration, website, description, figures reported, filing in 2 years.
// Hex columns are compared as they are (lower-case; TASK-047).

export { TRUST_SCORE_VERSION };

/** Imported organisations per statement (~1 s each on the first pass locally; the server has a 30 s statement timeout). */
export const IMPORTED_CHUNK = 10_000;

export type TrustScope = "registered" | "imported" | "all";

export interface TrustResult {
  scope: TrustScope;
  written: number;
}

const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
const SUCCEEDED = list(SUCCEEDED_CAMPAIGN_STATES);
const FINISHED = list([...SUCCEEDED_CAMPAIGN_STATES, "FAILED", "REJECTED"]);

/** Organisations on CHERR.IO (and registered applicants, to unlist them while not approved). */
const registeredScores = sql`
  with orgs as (
    select o.id, o.country, o.causes, o.kyb_status, o.is_demo from app.organizations o where o.source = 'REGISTERED'
  ),
  camp as (
    select c.org_id, ch.address, ch.state::text as state, ch.total_raised, ch.tranches_released, c.id as campaign_id
    from app.campaigns c join chain.campaign ch on ch.address = c.onchain_address
    where c.org_id in (select id from orgs)
  ),
  per_org as (
    select o.id,
      coalesce((select count(*) from app.ratings r where r.org_id = o.id), 0) as n_ratings,
      coalesce((select sum(r.stars) from app.ratings r where r.org_id = o.id), 0) as sum_stars,
      coalesce((select count(*) from camp where camp.org_id = o.id and camp.state in (${SUCCEEDED})), 0) as succeeded,
      coalesce((select count(*) from camp where camp.org_id = o.id and camp.state in (${FINISHED})), 0) as finished,
      coalesce((select count(*) from chain.vote_round v join camp on camp.address = v.campaign
                where camp.org_id = o.id and v.outcome::text in ('PAYING', 'COMPLETED')), 0) as approved,
      coalesce((select count(*) from chain.vote_round v join camp on camp.address = v.campaign
                where camp.org_id = o.id and v.outcome::text in ('PAYING', 'COMPLETED', 'REJECTED')), 0) as decided,
      coalesce((select sum(camp.tranches_released) from camp where camp.org_id = o.id), 0) as released,
      coalesce((select count(*) from app.evidence_bundles e join camp on camp.campaign_id = e.campaign_id
                where camp.org_id = o.id and e.status <> 'DRAFT'), 0) as evidence,
      coalesce((select sum(camp.total_raised) from camp where camp.org_id = o.id), 0) as raised
    from orgs o
  ),
  parts as (
    select p.*,
      (5 * 3.5 + p.sum_stars) / (5 + p.n_ratings) / 5.0 as c_rating,
      case when p.finished < 3 then 0.5 else p.succeeded::numeric / p.finished end as c_success,
      case when p.decided = 0 then 0.5 else p.approved::numeric / p.decided end as c_milestones,
      case when p.released = 0 then 0.5 else least(1, p.evidence::numeric / p.released) end as c_evidence
    from per_org p
  )
  select o.id as org_id,
    round(100 * (0.30 * x.c_rating + 0.25 * x.c_success + 0.20 * x.c_milestones + 0.15 * x.c_evidence + 0.10), 2) as score,
    jsonb_build_object(
      'kind', 'registered',
      'rating', round(x.c_rating, 4), 'ratings', x.n_ratings,
      'success', round(x.c_success, 4), 'finished', x.finished, 'succeeded', x.succeeded,
      'milestones', round(x.c_milestones, 4), 'decided', x.decided, 'approved', x.approved,
      'evidence', round(x.c_evidence, 4), 'released', x.released, 'submitted', x.evidence,
      'verification', 1
    ) as components,
    (o.kyb_status = 'APPROVED' and not o.is_demo) as listed,
    (o.kyb_status = 'APPROVED') as registered,
    o.country, o.causes, x.raised
  from orgs o join parts x on x.id = o.id
`;

/** Imported organisations in an id range: registry data completeness only (ADR-059 §2). */
const importedScores = (range: SQL) => sql`
  with base as (
    select o.id, o.country, o.causes, o.is_demo, o.website, o.description, o.registry, r.raw
    from app.organizations o
    left join app.registry_records r on r.registry = o.registry and r.registry_id = o.registry_id
    where o.source = 'IMPORTED' and ${range}
  ),
  checks as (
    select b.*,
      (b.raw is null or coalesce(b.raw->>'status', 'Registered') = 'Registered' or b.registry = 'US_IRS') as active,
      b.website is not null as has_website,
      b.description is not null as has_description,
      -- Register values are compared as text and never cast: one malformed value
      -- (a tax period "201913", a date "2023-02-30") would otherwise fail the whole pass.
      coalesce((jsonb_typeof(b.raw->'income') = 'number' and (b.raw->>'income')::numeric > 0)
        or (jsonb_typeof(b.raw->'revenue') = 'number' and (b.raw->>'revenue')::numeric > 0), false) as has_figures,
      coalesce(
        case when b.raw->>'financialYearEnd' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-[0-3][0-9]$'
          then b.raw->>'financialYearEnd' >= to_char(current_date - interval '2 years', 'YYYY-MM-DD') end,
        case when b.raw->>'taxPeriod' ~ '^[0-9]{4}(0[1-9]|1[0-2])$'
          then b.raw->>'taxPeriod' >= to_char(current_date - interval '2 years', 'YYYYMM') end,
        false
      ) as recent_filing
    from base b
  )
  select c.id as org_id,
    round(20 + 20 * ((c.active::int + c.has_website::int + c.has_description::int + c.has_figures::int + c.recent_filing::int) / 5.0), 2) as score,
    jsonb_build_object(
      'kind', 'imported',
      'completeness', round((c.active::int + c.has_website::int + c.has_description::int + c.has_figures::int + c.recent_filing::int) / 5.0, 4),
      'active', c.active, 'website', c.has_website, 'description', c.has_description, 'figures', c.has_figures, 'recentFiling', c.recent_filing,
      'verification', 0.5
    ) as components,
    (c.active and not c.is_demo) as listed,
    false as registered,
    c.country, c.causes, 0::numeric as raised
  from checks c
`;

async function upsert(db: Database, scores: SQL): Promise<number> {
  // Only the count comes back: ~1 M returned rows would not fit the worker's memory.
  const [row] = (await db.execute(sql`
    with s as (${scores}), written as (
    insert into app.trust_scores (id, org_id, version, score, components, listed, registered, country, causes, raised, computed_at)
    select gen_random_uuid(), s.org_id, ${TRUST_SCORE_VERSION}, s.score, s.components, s.listed, s.registered, s.country, s.causes, s.raised, now()
    from s
    on conflict (org_id, version) do update
      set score = excluded.score, components = excluded.components, listed = excluded.listed, registered = excluded.registered,
          country = excluded.country, causes = excluded.causes, raised = excluded.raised, computed_at = now()
      where (app.trust_scores.score, app.trust_scores.components, app.trust_scores.listed, app.trust_scores.registered,
             app.trust_scores.country, app.trust_scores.causes, app.trust_scores.raised)
        is distinct from (excluded.score, excluded.components, excluded.listed, excluded.registered,
             excluded.country, excluded.causes, excluded.raised)
    returning 1
    )
    select count(*)::int as n from written
  `)) as unknown as { n: number }[];
  return Number(row?.n ?? 0);
}

/**
 * Imported organisations in chunks of `chunk` ids: the database role has a 30 s
 * statement timeout (infra), and one statement over ~600k organisations ran past
 * it on dev. Each chunk is its own statement and commits on its own.
 */
async function upsertImported(db: Database, chunk: number): Promise<number> {
  let written = 0;
  let after: string | null = null;
  for (;;) {
    const from = after === null ? sql`true` : sql`o.id > ${after}::uuid`;
    const [edge] = (await db.execute(sql`
      select o.id from app.organizations o
      where o.source = 'IMPORTED' and ${from}
      order by o.id offset ${chunk - 1} limit 1
    `)) as unknown as { id: string }[];
    const to = edge ? sql`o.id <= ${edge.id}::uuid` : sql`true`;
    written += await upsert(db, importedScores(sql`${from} and ${to}`));
    if (!edge) return written;
    after = edge.id;
  }
}

/** Recomputes the scores in scope; returns how many rows changed. */
export async function computeTrustScores(
  db: Database,
  scope: TrustScope = "all",
  options: { chunk?: number } = {}
): Promise<TrustResult> {
  let written = 0;
  if (scope !== "imported") written += await upsert(db, registeredScores);
  if (scope !== "registered") written += await upsertImported(db, Math.max(1, options.chunk ?? IMPORTED_CHUNK));
  return { scope, written };
}
