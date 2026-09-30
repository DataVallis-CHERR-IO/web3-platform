#!/usr/bin/env bash
# infra/shared/initdb/01-databases.sh
# PostgreSQL init script — runs ONCE on first container start (empty data dir).
# For an already-running cluster use ensure-databases.sh instead.
#
# Creates roles, databases, and installs the vector extension.
# Environment variables are provided by Docker (from compose.yml / infra.env).
set -euo pipefail

log() { echo "[initdb] $*"; }

: "${POSTGRES_DEV_PASSWORD:?POSTGRES_DEV_PASSWORD is required}"
: "${POSTGRES_UAT_PASSWORD:?POSTGRES_UAT_PASSWORD is required}"
: "${POSTGRES_PROD_PASSWORD:?POSTGRES_PROD_PASSWORD is required}"
: "${PGBOUNCER_ADMIN_PASSWORD:?PGBOUNCER_ADMIN_PASSWORD is required}"

log "Creating roles and databases..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL

-- ───────── Roles ─────────
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cherrio_dev') THEN
    CREATE ROLE cherrio_dev LOGIN PASSWORD '${POSTGRES_DEV_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cherrio_uat') THEN
    CREATE ROLE cherrio_uat LOGIN PASSWORD '${POSTGRES_UAT_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cherrio_prod') THEN
    CREATE ROLE cherrio_prod LOGIN PASSWORD '${POSTGRES_PROD_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pgbouncer_admin') THEN
    CREATE ROLE pgbouncer_admin LOGIN PASSWORD '${PGBOUNCER_ADMIN_PASSWORD}';
  END IF;
END
\$\$;

-- Per-env connection limits and statement timeouts for dev/uat
ALTER ROLE cherrio_dev CONNECTION LIMIT 20;
ALTER ROLE cherrio_dev SET statement_timeout = '30s';
ALTER ROLE cherrio_uat CONNECTION LIMIT 20;
ALTER ROLE cherrio_uat SET statement_timeout = '30s';

-- ───────── Databases ─────────
SELECT 'CREATE DATABASE cherrio_dev OWNER cherrio_dev'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cherrio_dev') \gexec

SELECT 'CREATE DATABASE cherrio_uat OWNER cherrio_uat'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cherrio_uat') \gexec

SELECT 'CREATE DATABASE cherrio_prod OWNER cherrio_prod'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cherrio_prod') \gexec

-- Revoke public connect so roles can only reach their own DB
REVOKE CONNECT ON DATABASE cherrio_dev  FROM PUBLIC;
REVOKE CONNECT ON DATABASE cherrio_uat  FROM PUBLIC;
REVOKE CONNECT ON DATABASE cherrio_prod FROM PUBLIC;

SQL

# Install vector extension in each database
for db in cherrio_dev cherrio_uat cherrio_prod; do
  log "Installing pgvector in ${db}..."
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" \
    -c "CREATE EXTENSION IF NOT EXISTS vector;"
done

log "Done — roles, databases, and vector extension created."
