#!/usr/bin/env bash
# infra/backups/install-backups.sh
# Installs the backup systemd service and timer on the server.
# Must be run as root (or via sudo) from the repo checkout.
#
# Usage: sudo bash install-backups.sh
set -euo pipefail

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
ok()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✓ $*"; }
die() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✗ $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "Must be run as root"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="/etc/systemd/system"

# Verify env file exists before installing
ENV_FILE="/opt/cherrio/secrets/infra.env"
[[ -f "$ENV_FILE" ]] || die "Env file missing: ${ENV_FILE}. Create it first."

# shellcheck source=/dev/null
source "$ENV_FILE"
: "${POSTGRES_SUPERUSER_PASSWORD:?POSTGRES_SUPERUSER_PASSWORD must be set in ${ENV_FILE}}"
: "${AGE_PUBLIC_KEY:?AGE_PUBLIC_KEY must be set in ${ENV_FILE}}"
: "${RCLONE_REMOTE:?RCLONE_REMOTE must be set in ${ENV_FILE}}"

# Verify age private key exists
AGE_KEY_FILE="/opt/cherrio/secrets/backup-key.age"
[[ -f "$AGE_KEY_FILE" ]] || \
  log "⚠ age private key not found at ${AGE_KEY_FILE} — needed for restore.sh"

log "Installing systemd units..."
cp "${SCRIPT_DIR}/cherrio-backup.service" "${SYSTEMD_DIR}/cherrio-backup.service"
cp "${SCRIPT_DIR}/cherrio-backup.timer"   "${SYSTEMD_DIR}/cherrio-backup.timer"
chmod 644 "${SYSTEMD_DIR}/cherrio-backup.service"
chmod 644 "${SYSTEMD_DIR}/cherrio-backup.timer"
ok "Units copied to ${SYSTEMD_DIR}"

systemctl daemon-reload
ok "systemctl daemon-reload"

systemctl enable --now cherrio-backup.timer
ok "Timer enabled and started"

log ""
systemctl list-timers cherrio-backup.timer
log ""
log "Run a manual backup now:"
log "  sudo systemctl start cherrio-backup.service"
log "  journalctl -u cherrio-backup -f"
