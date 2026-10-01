-- infra/shared/indexer-role.sql
-- Idempotent: role for the Ponder indexer of ONE environment (TASK-026, ADR-026).
-- Run by ensure-databases.sh as the postgres superuser, CONNECTED TO THE ENV DATABASE:
--   psql -d cherrio_dev -v role=cherrio_indexer_dev -v web_role=cherrio_dev -v db=cherrio_dev -f -
-- The password comes from the environment variable INDEXER_PASSWORD (never argv).
--
-- Result:
--   * <role> can connect to <db> and create schemas there (chain_<sha7>, ponder_sync).
--   * <role> has no privilege on schema app (owned by <web_role>).
--   * schema chain is owned by <role>; <web_role> may read every view created
--     in it, also views Ponder re-creates on later deploys (default privileges).

\set ON_ERROR_STOP on
\getenv password INDEXER_PASSWORD

SELECT format('CREATE ROLE %I LOGIN', :'role')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role') \gexec

ALTER ROLE :"role" LOGIN PASSWORD :'password' CONNECTION LIMIT 10;

GRANT CONNECT, CREATE ON DATABASE :"db" TO :"role";

-- Ponder only does CREATE SCHEMA IF NOT EXISTS, so a pre-created schema keeps
-- its owner, its USAGE grant and its default privileges across deploys.
CREATE SCHEMA IF NOT EXISTS chain AUTHORIZATION :"role";
ALTER SCHEMA chain OWNER TO :"role";

GRANT USAGE ON SCHEMA chain TO :"web_role";
GRANT SELECT ON ALL TABLES IN SCHEMA chain TO :"web_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"role" IN SCHEMA chain
  GRANT SELECT ON TABLES TO :"web_role";
