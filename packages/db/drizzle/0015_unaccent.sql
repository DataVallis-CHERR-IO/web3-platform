-- TASK-054: accent-insensitive search ("sola" finds "Šola", "cafe" finds "Café").
-- unaccent ships with Postgres (contrib) and is a trusted extension since PG 13,
-- so the database owner (the app role that runs migrations) may create it.
CREATE EXTENSION IF NOT EXISTS "unaccent" WITH SCHEMA public;
