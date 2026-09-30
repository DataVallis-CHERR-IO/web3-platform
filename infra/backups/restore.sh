#!/usr/bin/env bash
# infra/backups/restore.sh
# Restore a pg_dump (-Fc) into a target database inside the postgres container.
# DEFAULT target: cherrio_restore_test (safe).
# Restoring to cherrio_prod requires --i-know-this-is-prod.
#
# MODES:
#
# 1. COUNTS mode — print exact row counts for any DB (no dump needed):
#      bash restore.sh --counts <dbname>
#
# 2. FILE mode  — server decrypts with local age private key (key must be on server):
#      bash restore.sh <dump.age> [--target <dbname>] [--i-know-this-is-prod]
#
# 3. STDIN mode — STANDARD for restore drills (private key NEVER touches server):
#      age -d -i ~/cherrio-backup.key dump.age | \
#        ssh deploy@49.13.63.71 \
#          'bash /opt/cherrio/infra/backups/restore.sh --stdin [<target-db>] [--i-know-this-is-prod]'
#
#    Plaintext pg_dump is piped over SSH; server only sees already-decrypted bytes.
#    See infra/backups/RESTORE-DRILL.md for the full procedure.
set -euo pipefail

###############################################################################
# Args
###############################################################################
COUNTS_MODE=false
COUNTS_DB=""
STDIN_MODE=false
DUMP_FILE=""
TARGET_DB="cherrio_restore_test"
ALLOW_PROD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --counts)              COUNTS_MODE=true; COUNTS_DB="$2"; shift 2 ;;
    --stdin)               STDIN_MODE=true; shift ;;
    --target)              TARGET_DB="$2"; shift 2 ;;
    --i-know-this-is-prod) ALLOW_PROD=true; shift ;;
    -*)                    echo "Unknown flag: $1" >&2; exit 1 ;;
    *)
      # In stdin mode a bare positional arg sets the target DB;
      # in file mode it is the path to the .dump.age file.
      if $STDIN_MODE; then
        TARGET_DB="$1"
      else
        DUMP_FILE="$1"
      fi
      shift ;;
  esac
done

log()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
ok()   { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✓ $*"; }
die()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✗ $*" >&2; exit 1; }

COMPOSE_FILE="/opt/cherrio/infra/shared/compose.yml"
COMPOSE="docker compose -f ${COMPOSE_FILE}"

###############################################################################
# count_tables <dbname>
# Prints exact SELECT count(*) per user table, generated dynamically from
# information_schema.tables (excludes pg_catalog and information_schema).
# Uses \gexec in a heredoc — valid because psql reads from stdin, not -c.
###############################################################################
count_tables() {
  local db="$1"
  log "Row counts in ${db}:"
  $COMPOSE exec -T postgres psql -U postgres -d "$db" <<'PSQL'
SELECT
  'SELECT ' || quote_literal(table_schema || '.' || table_name)
           || ' AS "table", count(*) AS rows FROM '
           || quote_ident(table_schema) || '.' || quote_ident(table_name)
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  AND table_type = 'BASE TABLE'
ORDER BY table_schema, table_name
\gexec
PSQL
}

###############################################################################
# COUNTS mode — just print row counts for the given DB and exit
###############################################################################
if $COUNTS_MODE; then
  [[ -n "$COUNTS_DB" ]] || die "Usage: restore.sh --counts <dbname>"
  count_tables "$COUNTS_DB"
  exit 0
fi

###############################################################################
# Validate restore-mode args
###############################################################################
if ! $STDIN_MODE; then
  [[ -n "$DUMP_FILE" ]] || die \
    "Usage: restore.sh --counts <db>
       restore.sh <dump.age>  [--target <db>] [--i-know-this-is-prod]
       restore.sh --stdin     [<target-db>]   [--i-know-this-is-prod]"
  [[ -f "$DUMP_FILE" ]] || die "Dump file not found: ${DUMP_FILE}"
fi

# Safety guard
if [[ "$TARGET_DB" == "cherrio_prod" ]] && ! $ALLOW_PROD; then
  die "Refusing to restore into cherrio_prod without --i-know-this-is-prod. " \
      "Use --target cherrio_restore_test for drills."
fi

###############################################################################
# Load env (needed for restore path only)
###############################################################################
ENV_FILE="${ENV_FILE:-/opt/cherrio/secrets/infra.env}"
[[ -f "$ENV_FILE" ]] || die "Env file not found: ${ENV_FILE}"
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

###############################################################################
# Obtain plaintext dump
#   FILE mode  — decrypt age-encrypted file with local key
#   STDIN mode — buffer stdin to tmpfile so later psql steps don't consume it
###############################################################################
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
PLAIN_DUMP="${TMPDIR}/restore.dump"

if $STDIN_MODE; then
  log "Reading plaintext dump from stdin..."
  cat > "$PLAIN_DUMP"
  ok "Buffered $(du -sh "$PLAIN_DUMP" | cut -f1) from stdin → ${PLAIN_DUMP}"
else
  AGE_KEY_FILE="${AGE_KEY_FILE:-/opt/cherrio/secrets/backup-key.age}"
  [[ -f "$AGE_KEY_FILE" ]] || die "age private key not found: ${AGE_KEY_FILE}"
  log "Decrypting ${DUMP_FILE}..."
  age --decrypt -i "$AGE_KEY_FILE" -o "$PLAIN_DUMP" "$DUMP_FILE" \
    || die "age decrypt failed"
  ok "Decrypted → ${PLAIN_DUMP}"
fi

###############################################################################
# Ensure target DB exists (runs inside postgres container — no host client needed)
# Redirect < /dev/null so psql does not consume any of the buffered dump data.
###############################################################################
log "Ensuring database '${TARGET_DB}' exists..."
_db_exists=$($COMPOSE exec -T postgres psql -U postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${TARGET_DB}'" < /dev/null)
if [[ "$_db_exists" != "1" ]]; then
  $COMPOSE exec -T postgres psql -U postgres -c \
    "CREATE DATABASE \"${TARGET_DB}\" OWNER postgres" < /dev/null > /dev/null
fi
ok "Target database: ${TARGET_DB}"

###############################################################################
# Restore (pg_restore reads the dump from the buffered tmpfile)
###############################################################################
log "Restoring into '${TARGET_DB}'..."
$COMPOSE exec -T postgres pg_restore \
  -U postgres \
  -d "$TARGET_DB" \
  --clean --if-exists \
  --no-owner --no-acl \
  --exit-on-error \
  < "$PLAIN_DUMP" \
  || die "pg_restore failed"
ok "Restore complete → ${TARGET_DB}"

###############################################################################
# Row counts
###############################################################################
count_tables "$TARGET_DB"

ok "Done. Verify row counts above match the source database."
log "To drop the restore test: ${COMPOSE} exec -T postgres psql -U postgres -c 'DROP DATABASE ${TARGET_DB};'"
