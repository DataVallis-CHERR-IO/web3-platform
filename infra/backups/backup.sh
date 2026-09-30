#!/usr/bin/env bash
# infra/backups/backup.sh
# Backs up Postgres databases, encrypts with age, uploads with rclone.
# Schedule: cherrio_prod daily at 02:30 UTC; cherrio_uat on Sundays.
# Called by the systemd cherrio-backup timer unit.
#
# pg_dump runs INSIDE the postgres container via `docker compose exec -T`
# so no postgres client is required on the host.
#
# Usage: bash backup.sh [--dry-run]
set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

###############################################################################
# Config — read from env (systemd EnvironmentFile=/opt/cherrio/secrets/infra.env)
###############################################################################
: "${AGE_PUBLIC_KEY:?}"
: "${RCLONE_REMOTE:?}"

BACKUP_DIR="/opt/cherrio/backups"
COMPOSE_FILE="/opt/cherrio/infra/shared/compose.yml"
COMPOSE="docker compose -f ${COMPOSE_FILE}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DOW="$(date -u +%u)"   # 1=Monday … 7=Sunday

log()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
ok()   { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✓ $*"; }
warn() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ⚠ $*" >&2; }
die()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✗ $*" >&2
         notify_failure "$*"
         exit 1; }

notify_failure() {
  local msg="$1"
  if [[ -n "${BACKUP_ALERT_WEBHOOK:-}" ]]; then
    curl -s -X POST "$BACKUP_ALERT_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"[cherrio-1] Backup FAILED: ${msg}\"}" || true
  fi
}

run() { $DRY_RUN && { echo "[DRY-RUN] $*"; return 0; }; "$@"; }

###############################################################################
# Dump one database
# pg_dump runs inside the container (trust auth for postgres user).
###############################################################################
dump_db() {
  local db="$1"
  local dump_file="${BACKUP_DIR}/${db}_${TIMESTAMP}.dump"
  local enc_file="${dump_file}.age"

  log "Dumping ${db} via docker compose exec..."
  if $DRY_RUN; then
    echo "[DRY-RUN] ${COMPOSE} exec -T postgres pg_dump -U postgres -Fc ${db} > ${dump_file}"
  else
    $COMPOSE exec -T postgres pg_dump -U postgres -Fc "$db" > "$dump_file" \
      || die "pg_dump failed for ${db}"
    ok "Dump: ${dump_file} ($(du -sh "$dump_file" 2>/dev/null | cut -f1 || echo '?'))"
  fi

  log "Encrypting ${dump_file}..."
  run age -r "$AGE_PUBLIC_KEY" -o "$enc_file" "$dump_file" \
    || die "age encrypt failed for ${db}"
  run rm -f "$dump_file"
  ok "Encrypted: ${enc_file}"

  log "Uploading to ${RCLONE_REMOTE}:${db}/..."
  run rclone copy "$enc_file" "${RCLONE_REMOTE}:${db}/" \
    || die "rclone upload failed for ${db}"
  ok "Uploaded"

  # Keep 3 local encrypted dumps per database
  if ! $DRY_RUN; then
    local count
    count=$(ls -1 "${BACKUP_DIR}/${db}_"*.dump.age 2>/dev/null | wc -l)
    if [[ "$count" -gt 3 ]]; then
      ls -1t "${BACKUP_DIR}/${db}_"*.dump.age | tail -n +4 | xargs rm -f
      ok "Pruned local copies (kept 3)"
    fi
  fi
}

###############################################################################
# Prune remote — delete dumps older than 56 days (14 daily + 8 weekly headroom)
###############################################################################
prune_remote() {
  local db="$1"
  run rclone delete "${RCLONE_REMOTE}:${db}/" \
    --min-age 56d \
    || warn "Remote prune failed for ${db} (non-fatal)"
}

###############################################################################
# Main
###############################################################################
log "=== Backup started (DOW=${DOW}, DRY_RUN=${DRY_RUN}) ==="
mkdir -p "$BACKUP_DIR"

# prod: every day
dump_db cherrio_prod
prune_remote cherrio_prod

# uat: Sundays only
if [[ "$DOW" == "7" ]]; then
  dump_db cherrio_uat
  prune_remote cherrio_uat
else
  log "Skipping cherrio_uat (not Sunday)"
fi

log "=== Backup completed ==="
