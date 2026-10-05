-- TASK-046: the Emergency Pool sub-pools are reference data every environment
-- needs (the donate panel offers only rows that also exist on chain). Until now
-- they came from `pnpm --filter db seed`, which no deploy runs. Same rows and
-- keys as packages/db/src/seed.ts; existing rows are left untouched. The id has
-- no database default (uuidPk is filled by the app), so it is generated here.
INSERT INTO "app"."emergency_subpools" ("id", "pool_id", "slug", "name_key", "description_key") VALUES
  (gen_random_uuid(), 0, 'general',   'pool.general.name',   'pool.general.description'),
  (gen_random_uuid(), 1, 'medical',   'pool.medical.name',   'pool.medical.description'),
  (gen_random_uuid(), 2, 'disasters', 'pool.disasters.name', 'pool.disasters.description'),
  (gen_random_uuid(), 3, 'animals',   'pool.animals.name',   'pool.animals.description'),
  (gen_random_uuid(), 4, 'climate',   'pool.climate.name',   'pool.climate.description')
ON CONFLICT DO NOTHING;
