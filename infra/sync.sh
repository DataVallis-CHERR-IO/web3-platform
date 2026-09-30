#!/usr/bin/env bash
# infra/sync.sh
# Sync infra/ from the local repo to the server.
# Run from the repo root before every server-side operation that needs
# updated scripts or configs.
#
# What it syncs:  infra/ → deploy@49.13.63.71:/opt/cherrio/infra/
# What it skips:
#   pgbouncer/   — generated at runtime by ensure-databases.sh; never overwrite
#
# Usage:
#   bash infra/sync.sh           # dry-run first (shows changes)
#   bash infra/sync.sh --live    # actually transfer
set -euo pipefail

SERVER="deploy@49.13.63.71"
REMOTE_DIR="/opt/cherrio/infra/"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/"

RSYNC_OPTS=(
  -av
  --delete
  --exclude="pgbouncer/"    # generated on server; never clobber
  --exclude=".DS_Store"
)

if [[ "${1:-}" == "--live" ]]; then
  echo "==> Syncing ${LOCAL_DIR} → ${SERVER}:${REMOTE_DIR}"
  rsync "${RSYNC_OPTS[@]}" "$LOCAL_DIR" "${SERVER}:${REMOTE_DIR}"
  echo "==> Done."
else
  echo "==> Dry-run: ${LOCAL_DIR} → ${SERVER}:${REMOTE_DIR}"
  echo "    (pass --live to actually transfer)"
  rsync "${RSYNC_OPTS[@]}" --dry-run "$LOCAL_DIR" "${SERVER}:${REMOTE_DIR}"
fi
