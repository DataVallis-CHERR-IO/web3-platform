# TASK-005 feedback
Status: DONE

## What I implemented
- Full Drizzle schema in `packages/db/src/schema/` — 18 tables, 17 Postgres enums,
  all in schema `app` (Ponder's `chain` schema untouched).
- UUID v7 primary keys generated in TS via `uuid@14` `$defaultFn`.
- Custom Drizzle type `numeric78`: `numeric(78,0)` ↔ TypeScript `bigint` (USDC amounts).
- Custom Drizzle type `bytea`: `bytea` ↔ `Buffer` (offchain_id, bundle_hash).
- All CHECK constraints: address format (`^0x[0-9a-f]{40}$`), `offchain_id` and
  `bundle_hash` length = 32, `stars` 1–5, `pool_id >= 0`,
  `beneficiary_address` required when `status IN ('APPROVED','DEPLOYED')`.
- All FK indexes plus the specific indexes from the task spec.
- `CREATE EXTENSION IF NOT EXISTS "vector"` in migration 0000 (no vector columns yet).
- `src/migrate.ts` — migrations journal in `app.__drizzle_migrations`.
- `src/seed.ts` — idempotent: 5 sub-pools, 3 imported orgs, optional platform admin
  from `SEED_ADMIN_ADDRESS` env var; address-first lookup in one transaction.
  Accepts optional `opts.adminAddress` for test injection without mutating env vars.
  Prefers `DATABASE_URL_DIRECT` (direct Postgres, not PgBouncer) for session features.
- `src/gdpr.ts` — `eraseUser(db, userId)` in one transaction (see Deviations §3).
- `src/index.ts` — `createDb(url, opts?)` with `prepare:false, max:10` for PgBouncer
  transaction mode; inferred types; `eraseUser` re-export.
- `drizzle/0000_perpetual_dust.sql` — generated migration + manual vector extension prepend.
- `src/__tests__/integration.test.ts` — 11 integration tests (11/11 passing).

## Files changed
- `packages/db/src/schema/enums.ts` — created: all 17 app-schema Postgres enums
- `packages/db/src/schema/helpers.ts` — created: `uuidPk`, `numeric78`, `bytea` types
- `packages/db/src/schema/users.ts` — created: users, user_addresses, user_roles
- `packages/db/src/schema/organizations.ts` — created: organizations, org_members, kyb_submissions
- `packages/db/src/schema/kyc.ts` — created: kyc_checks
- `packages/db/src/schema/campaigns.ts` — created: campaigns, campaign_media, evidence_bundles
- `packages/db/src/schema/social.ts` — created: ratings, points_ledger, user_levels
- `packages/db/src/schema/trust.ts` — created: trust_scores, registry_records
- `packages/db/src/schema/emergency.ts` — created: emergency_subpools
- `packages/db/src/schema/finance.ts` — created: onramp_orders
- `packages/db/src/schema/audit.ts` — created: audit_log
- `packages/db/src/schema/index.ts` — replaced: re-exports all above
- `packages/db/src/migrate.ts` — updated: `migrationsSchema: "app"`, absolute path
- `packages/db/src/seed.ts` — created: idempotent seed
- `packages/db/src/gdpr.ts` — created: eraseUser GDPR helper
- `packages/db/src/index.ts` — updated: added eraseUser export and inferred types
- `packages/db/src/__tests__/integration.test.ts` — created: 10 integration tests
- `packages/db/drizzle.config.ts` — updated: `migrations.schema: "app"`
- `packages/db/drizzle/0000_perpetual_dust.sql` — created: migration SQL
- `packages/db/drizzle/meta/` — created: drizzle journal metadata
- `packages/db/package.json` — updated: added `seed`, `test:integration`, fixed `db:generate`

## Post-review fixes (review round 1)

### Fix 1 — Seed admin idempotency (address-first)
`seed.ts` now opens a transaction and queries `user_addresses.address` **first**.
Only if the address is absent does it insert a new `users` row; then it inserts the
address. The `PLATFORM_ADMIN` role uses `onConflictDoNothing`. Two consecutive seed runs
with the same `SEED_ADMIN_ADDRESS` leave exactly 1 user, 1 address, 1 role — verified
by the new integration test `admin idempotency`.

### Fix 2 — PgBouncer transaction mode
`createDb(url, opts?)` creates the `postgres()` client with `{ prepare: false, max: opts?.max ?? 10 }`.
`prepare: false` is mandatory for PgBouncer transaction-mode pooling (prepared statements
are session-scoped and unavailable across pooled connections). App code passes `DATABASE_URL`
(PgBouncer). `migrate.ts` and `seed.ts` prefer `DATABASE_URL_DIRECT` (direct Postgres)
because advisory locks and session features used by the migrator are not PgBouncer-safe.
Both variables documented in `.env.example`.

### Fix 3 — `vector` extension and superuser concern
`infra/shared/ensure-databases.sh` lines 105-108 already run
`CREATE EXTENSION IF NOT EXISTS vector` against all three databases **as the postgres
superuser** via `docker compose exec postgres psql -U postgres`. No edits were required —
this code was already present and correct before this task branch.
The `CREATE EXTENSION IF NOT EXISTS "vector"` in migration 0000 is a safe no-op on
production (extension already installed by the shell script when the migration runs).

---

## Deviations from the task (and why)

1. **`user_roles` reduced to `PLATFORM_ADMIN` only** (CTO decision approved during review):
   `ORG_ADMIN` and `ORG_MEMBER` removed from `user_roles`; org membership lives solely
   in `org_members(org_id, user_id, role: ORG_ADMIN|ORG_MEMBER, unique(org_id,user_id))`.
   Eliminates the data-duplication risk between the two tables.

2. **`db:generate` uses `node -r tsx/cjs`** instead of plain `drizzle-kit generate`:
   drizzle-kit 0.30's CJS bundler cannot resolve `.js` extension imports to `.ts` source
   files (NodeNext module resolution). Wrapping with tsx's CJS hook fixes this transparently.
   No behaviour change.

3. **`eraseUser` nulls `ratings.signature`** in addition to the explicitly listed fields:
   EIP-712 signatures are cryptographic proof of the signer's private key — they are
   personal data. Stars and comment are kept (pseudonymous; required for Trust Score).

4. **`campaigns.eur_usd_rate`, `rate_source`, `rate_at`, `target_usdc`, `offchain_id`
   are nullable** in the Drizzle schema (not in the migration constraint): these fields
   are only set at admin approval / deployment time, so a DRAFT campaign legitimately
   has NULLs. Setting them NOT NULL would block draft creation.

5. **`onramp_orders.fiat_amount_cents` is `bigint` not `text`**: task spec did not
   specify the type; bigint is the natural choice for integer cents.

6. **`CREATE SCHEMA IF NOT EXISTS "app"`** instead of `CREATE SCHEMA "app"` in migration:
   Drizzle ORM creates the `app` schema for its own `__drizzle_migrations` table before
   applying migration SQL, so the bare CREATE SCHEMA would always fail on re-run.
   IF NOT EXISTS is required for idempotency (matches Manifest §3 backward-compat rule).

## New dependencies
- `uuid@^14.0.2` — UUID v7 generation in application (Postgres 16 has no `uuidv7()`).
  David specified this package explicitly.
- `@types/uuid@^11.0.0` (devDependency) — stub; `uuid` v14 ships its own types (removed
  automatically, installed as a no-op per pnpm warning).

## How to verify
```sh
# 1. Start local Postgres (docker-compose.dev.yml)
docker compose -f docker-compose.dev.yml up -d postgres

# 2. Migrate (run twice to confirm idempotency)
DATABASE_URL=postgres://cherrio:cherrio@localhost:5432/cherrio_dev \
  pnpm --filter db migrate
DATABASE_URL=postgres://cherrio:cherrio@localhost:5432/cherrio_dev \
  pnpm --filter db migrate   # second run: "Migrations complete." no error

# 3. Seed (run twice to confirm idempotency)
DATABASE_URL=postgres://cherrio:cherrio@localhost:5432/cherrio_dev \
  pnpm --filter db seed
DATABASE_URL=postgres://cherrio:cherrio@localhost:5432/cherrio_dev \
  pnpm --filter db seed      # second run: same counts, no duplicates

# 4. Integration tests
DATABASE_URL=postgres://cherrio:cherrio@localhost:5432/cherrio_dev \
  pnpm --filter db test:integration
# Expected: 11 tests pass

# 5. Type-check
pnpm --filter db typecheck
```

## Test results (after review fixes)
```
 ✓ src/__tests__/integration.test.ts (11 tests) 462ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  1.22s
```
Tests covered:
- `migrations` (4): applies from zero, creates all 18 tables, journal in `app` schema,
  second apply is no-op
- `seed` (5): runs, correct sub-pool count (5), correct org count (3), idempotent,
  **admin idempotency — two runs leave exactly 1 user / 1 address / 1 role**
- `bigint round-trip` (1): stores and retrieves `2^256 − 1` (max uint256) exactly
- `eraseUser GDPR` (1): verifies anonymisation + row deletions in one transaction

## Open questions / risks
- **Extension permission**: ~~`CREATE EXTENSION vector` requires superuser — resolved~~.
  `infra/shared/ensure-databases.sh` already calls `CREATE EXTENSION IF NOT EXISTS vector`
  as the `postgres` superuser for all three databases (lines 105-108). The migration's
  `CREATE EXTENSION IF NOT EXISTS "vector"` is therefore a safe no-op on production.
- **Audit log IP GDPR**: eraseUser nulls `ip` for all rows where `actor_user_id = userId`,
  but rows where `entity_id = userId` from another actor's action are not touched.
  This is deliberate (the IP belongs to the actor, not the subject), but worth confirming.

## ER Diagram (Mermaid)

```mermaid
erDiagram
    users {
        uuid id PK
        text display_name
        text email
        text privy_did
        varchar locale
        bool anonymous_donations
    }
    user_addresses {
        uuid id PK
        uuid user_id FK
        varchar address
        enum kind
        bool is_primary
    }
    user_roles {
        uuid id PK
        uuid user_id FK
        enum role
    }
    user_levels {
        uuid user_id PK_FK
        int level
        bigint status_points
        bigint reward_points
    }
    kyc_checks {
        uuid id PK
        uuid user_id FK
        text provider
        text applicant_id
        enum status
    }
    organizations {
        uuid id PK
        enum source
        text name
        char country
        enum registry
        text registry_id
        enum kyb_status
        uuid claimed_by_user_id FK
        varchar payout_address
    }
    org_members {
        uuid id PK
        uuid org_id FK
        uuid user_id FK
        enum role
    }
    kyb_submissions {
        uuid id PK
        uuid org_id FK
        uuid submitted_by FK
        enum status
        uuid reviewer_id FK
    }
    campaigns {
        uuid id PK
        bytea offchain_id
        uuid org_id FK
        uuid starter_user_id FK
        enum beneficiary_type
        varchar beneficiary_address
        text slug
        bigint target_eur_cents
        numeric_78_0 target_usdc
        enum status
        varchar onchain_address
    }
    campaign_media {
        uuid id PK
        uuid campaign_id FK
        enum kind
        text cid
        enum storage
    }
    evidence_bundles {
        uuid id PK
        uuid campaign_id FK
        int round
        bytea bundle_hash
        enum status
    }
    ratings {
        uuid id PK
        uuid org_id FK
        uuid campaign_id FK
        uuid user_id FK
        int stars
        text signature
    }
    points_ledger {
        uuid id PK
        uuid user_id FK
        enum bucket
        bigint delta
        enum reason
        int rule_version
    }
    trust_scores {
        uuid id PK
        uuid org_id FK
        int version
        numeric_5_2 score
        jsonb components
    }
    registry_records {
        uuid id PK
        enum registry
        text registry_id
        jsonb raw
    }
    emergency_subpools {
        uuid id PK
        int pool_id
        text slug
        text name_key
    }
    onramp_orders {
        uuid id PK
        uuid user_id FK
        enum provider
        text provider_order_id
        enum status
        bigint fiat_amount_cents
        numeric_78_0 usdc_amount
        uuid campaign_id FK
    }
    audit_log {
        uuid id PK
        uuid actor_user_id FK
        text action
        text entity_type
        uuid entity_id
        text ip
    }

    users ||--o{ user_addresses : "has"
    users ||--o{ user_roles : "has"
    users ||--o| user_levels : "has"
    users ||--o{ kyc_checks : "verified by"
    users ||--o{ org_members : "member of"
    users ||--o{ kyb_submissions : "submits"
    users ||--o{ campaigns : "starts"
    users ||--o{ ratings : "writes"
    users ||--o{ points_ledger : "earns"
    users ||--o{ onramp_orders : "places"
    users ||--o{ audit_log : "audited"
    organizations ||--o{ org_members : "has"
    organizations ||--o{ kyb_submissions : "subject of"
    organizations ||--o{ campaigns : "runs"
    organizations ||--o{ ratings : "rated by"
    organizations ||--o{ trust_scores : "scored by"
    campaigns ||--o{ campaign_media : "has"
    campaigns ||--o{ evidence_bundles : "has"
    campaigns ||--o{ ratings : "after"
    campaigns ||--o{ onramp_orders : "for"
```

## Suggested commit message
```
feat(db): TASK-005 — Drizzle schema, migrations, seed, GDPR eraseUser

- 18 tables, 17 enums in schema `app`; Ponder `chain` schema untouched
- UUID v7 PKs via uuid@14; numeric(78,0) → bigint custom type for USDC
- CHECK constraints: address format, 32-byte hash lengths, stars 1-5,
  pool_id >= 0, beneficiary_address required when status APPROVED/DEPLOYED
- Migration 0000: CREATE EXTENSION vector + all DDL
- Idempotent seed: 5 emergency sub-pools, 3 imported orgs, optional admin
- eraseUser() GDPR helper in single transaction
- 10/10 integration tests passing against local docker Postgres
```
