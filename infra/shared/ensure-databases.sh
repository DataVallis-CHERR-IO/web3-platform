#!/usr/bin/env bash
# infra/shared/ensure-databases.sh
# Idempotent setup for an already-running Postgres cluster.
# Run this:
#   - After `docker compose up -d postgres` on first deploy
#   - After any recovery that re-initializes the Postgres data volume
#   - When passwords in infra.env change (re-generates pgbouncer config)
#
# Postgres must be healthy before running this script.
# PgBouncer is restarted automatically after config is regenerated.
#
# Usage: bash ensure-databases.sh [<path-to-infra.env>]
#   Default env file: /opt/cherrio/secrets/infra.env
set -euo pipefail

ENV_FILE="${1:-/opt/cherrio/secrets/infra.env}"

log()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
ok()   { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✓ $*"; }
warn() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ⚠ $*" >&2; }
die()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✗ $*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "Env file not found: ${ENV_FILE}"
# set -a exports every variable so docker compose child processes can read them
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

COMPOSE_FILE="/opt/cherrio/infra/shared/compose.yml"
COMPOSE="docker compose -f ${COMPOSE_FILE}"
PGBOUNCER_CONF_DIR="/opt/cherrio/infra/pgbouncer"

# Helper: run SQL inside the postgres container as the postgres superuser
pg_exec() {
  local db="${1:-postgres}"
  shift
  $COMPOSE exec -T postgres psql -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"
}

###############################################################################
# Wait for Postgres to be healthy
###############################################################################
log "Waiting for Postgres to be healthy..."
for i in {1..30}; do
  if $COMPOSE exec -T postgres pg_isready -U postgres -q 2>/dev/null; then
    ok "Postgres is ready"
    break
  fi
  [[ $i -lt 30 ]] || die "Postgres did not become ready in 60 s"
  sleep 2
done

###############################################################################
# Ensure roles, databases, and vector extension
###############################################################################
log "Ensuring roles and databases..."
pg_exec postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cherrio_dev') THEN
    CREATE ROLE cherrio_dev LOGIN PASSWORD '${POSTGRES_DEV_PASSWORD}';
    RAISE NOTICE 'Role cherrio_dev created';
  ELSE
    ALTER ROLE cherrio_dev PASSWORD '${POSTGRES_DEV_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cherrio_uat') THEN
    CREATE ROLE cherrio_uat LOGIN PASSWORD '${POSTGRES_UAT_PASSWORD}';
    RAISE NOTICE 'Role cherrio_uat created';
  ELSE
    ALTER ROLE cherrio_uat PASSWORD '${POSTGRES_UAT_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cherrio_prod') THEN
    CREATE ROLE cherrio_prod LOGIN PASSWORD '${POSTGRES_PROD_PASSWORD}';
    RAISE NOTICE 'Role cherrio_prod created';
  ELSE
    ALTER ROLE cherrio_prod PASSWORD '${POSTGRES_PROD_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pgbouncer_admin') THEN
    CREATE ROLE pgbouncer_admin LOGIN PASSWORD '${PGBOUNCER_ADMIN_PASSWORD}';
    RAISE NOTICE 'Role pgbouncer_admin created';
  ELSE
    ALTER ROLE pgbouncer_admin PASSWORD '${PGBOUNCER_ADMIN_PASSWORD}';
  END IF;
END
\$\$;

ALTER ROLE cherrio_dev CONNECTION LIMIT 20;
ALTER ROLE cherrio_dev SET statement_timeout = '30s';
ALTER ROLE cherrio_uat CONNECTION LIMIT 20;
ALTER ROLE cherrio_uat SET statement_timeout = '30s';

SELECT 'CREATE DATABASE cherrio_dev OWNER cherrio_dev'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cherrio_dev') \gexec
SELECT 'CREATE DATABASE cherrio_uat OWNER cherrio_uat'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cherrio_uat') \gexec
SELECT 'CREATE DATABASE cherrio_prod OWNER cherrio_prod'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cherrio_prod') \gexec

REVOKE CONNECT ON DATABASE cherrio_dev  FROM PUBLIC;
REVOKE CONNECT ON DATABASE cherrio_uat  FROM PUBLIC;
REVOKE CONNECT ON DATABASE cherrio_prod FROM PUBLIC;
SQL

for db in cherrio_dev cherrio_uat cherrio_prod; do
  pg_exec "$db" -c "CREATE EXTENSION IF NOT EXISTS vector;" > /dev/null
  ok "vector extension in ${db}"
done

###############################################################################
# Generate PgBouncer config
# auth_type = scram-sha-256: clients authenticate to PgBouncer with SCRAM.
#
# userlist.txt holds the PLAIN-TEXT role passwords (from infra.env), not the
# SCRAM verifiers from pg_authid. With only a verifier, PgBouncer cannot open
# server connections on its own (min_pool_size, forced user= in [databases]):
# Postgres rejects it with "server login failed: wrong password type".
# The plain-text passwords already live in infra.env on this host (mode 600);
# userlist.txt gets the same protection (mode 600, uid 70).
###############################################################################
log "Generating PgBouncer config in ${PGBOUNCER_CONF_DIR}..."
mkdir -p "$PGBOUNCER_CONF_DIR"

cat > "${PGBOUNCER_CONF_DIR}/pgbouncer.ini" <<EOF
[databases]
cherrio_dev  = host=postgres port=5432 dbname=cherrio_dev  user=cherrio_dev
cherrio_uat  = host=postgres port=5432 dbname=cherrio_uat  user=cherrio_uat
cherrio_prod = host=postgres port=5432 dbname=cherrio_prod user=cherrio_prod

[pgbouncer]
listen_addr              = 0.0.0.0
listen_port              = 6432
auth_type                = scram-sha-256
auth_file                = /etc/pgbouncer/userlist.txt
pool_mode                = transaction
max_client_conn          = 200
default_pool_size        = 20
min_pool_size            = 2
reserve_pool_size        = 5
reserve_pool_timeout     = 3
server_idle_timeout      = 600
client_idle_timeout      = 0
log_connections          = 0
log_disconnections       = 0
log_pooler_errors        = 1
stats_period             = 60
ignore_startup_parameters = extra_float_digits
admin_users              = pgbouncer_admin
EOF
chmod 644 "${PGBOUNCER_CONF_DIR}/pgbouncer.ini"
ok "pgbouncer.ini written (auth_type=scram-sha-256)"

# Write plain-text passwords; escape " as "" (PgBouncer auth_file format)
log "Writing userlist.txt from infra.env passwords..."
umask 077
true > "${PGBOUNCER_CONF_DIR}/userlist.txt"
add_user() {
  local role="$1" password="$2"
  [[ -n "$password" ]] || die "Empty password for role '${role}' in ${ENV_FILE}"
  printf '"%s" "%s"\n' "$role" "${password//\"/\"\"}" >> "${PGBOUNCER_CONF_DIR}/userlist.txt"
  ok "  ${role}: added"
}
add_user cherrio_dev     "${POSTGRES_DEV_PASSWORD}"
add_user cherrio_uat     "${POSTGRES_UAT_PASSWORD}"
add_user cherrio_prod    "${POSTGRES_PROD_PASSWORD}"
add_user pgbouncer_admin "${PGBOUNCER_ADMIN_PASSWORD}"

# Mode 600, owned by uid 70 (pgbouncer user inside the container) so the
# pgbouncer process can read it without running the container as root.
chmod 600 "${PGBOUNCER_CONF_DIR}/userlist.txt"
sudo chown -R 70:70 "${PGBOUNCER_CONF_DIR}" \
  || warn "sudo chown 70:70 failed — pgbouncer may not start if files are unreadable"
ok "userlist.txt written (mode 600, uid 70)"

###############################################################################
# Restart pgbouncer so it picks up the new config
###############################################################################
if $COMPOSE ps pgbouncer 2>/dev/null | grep -qE "Up|running"; then
  log "Restarting pgbouncer to apply new config..."
  $COMPOSE restart pgbouncer
  ok "pgbouncer restarted"
fi

ok "All databases, roles, and PgBouncer config are ready."
