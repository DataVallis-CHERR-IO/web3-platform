#!/usr/bin/env bash
# GHCR clean-up: deletes old "tested image" versions that only carry tree-* tags.
#
# CI pushes every tested PR image as <image>:tree-<base>-<tree> (build once,
# PR #183) — a single manifest. When Deploy reuses it, `imagetools create`
# wraps it in a NEW index tagged sha-<7>, so the tested version keeps only its
# tree-* tag and is a child of that deploy index. What piles up are images of
# superseded PR pushes. This script deletes versions whose every tag starts with
# "tree-", and only when
#   - they are older than KEEP_DAYS (default 21 — longer than the 14-day
#     retention of the tested-image artifact, so Deploy can never pick one), and
#   - their digest is not a child of ANY version that carries a non-tree tag
#     (every deploy and rollback image stays complete).
# Untagged versions (attestation manifests of Deploy builds) are never touched.
# Only the packages cherrio/web, cherrio/worker and cherrio/indexer are accepted.
#
# Usage: ghcr-cleanup.sh <org> <package> [--apply]
#   without --apply it only prints what it would delete (dry run).
# Needs GH_TOKEN with packages write and `docker login ghcr.io` for the index check.
# GH, IMAGETOOLS and CLEANUP_NOW (epoch seconds) override `gh`, `docker buildx
# imagetools` and the clock (tests).
set -euo pipefail
ORG="${1:-}"
PKG="${2:-}"
MODE="${3:-}"
GH="${GH:-gh}"
IMAGETOOLS="${IMAGETOOLS:-docker buildx imagetools}"
KEEP_DAYS="${KEEP_DAYS:-21}"
NOW="${CLEANUP_NOW:-$(date +%s)}"

if ! [[ "$ORG" =~ ^[A-Za-z0-9-]+$ ]]; then echo "::error::bad org '$ORG'"; exit 1; fi
case "$PKG" in cherrio/web|cherrio/worker|cherrio/indexer) ;; *) echo "::error::bad package '$PKG'"; exit 1 ;; esac
case "$MODE" in ""|--apply) ;; *) echo "::error::unknown option '$MODE'"; exit 1 ;; esac
if ! [[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || [ "$KEEP_DAYS" -lt 1 ]; then echo "::error::KEEP_DAYS must be ≥ 1"; exit 1; fi

ENC="${PKG//\//%2F}"
IMAGE="ghcr.io/$(echo "$ORG" | tr '[:upper:]' '[:lower:]')/$PKG"
API="orgs/$ORG/packages/container/$ENC/versions"
CUTOFF=$((NOW - KEEP_DAYS * 86400))

# id <TAB> digest <TAB> created_at <TAB> tags (comma separated); order does not matter.
VERSIONS=$($GH api --paginate "$API?per_page=100" \
  --jq '.[] | [.id, .name, .created_at, ((.metadata.container.tags // []) | join(","))] | @tsv')
[ -n "$VERSIONS" ] || { echo "No versions in $PKG."; exit 0; }

# True when at least one tag is not a tree-* tag (a deploy tag such as sha-<7>).
has_deploy_tag() {
  local tag
  local -a list
  IFS=, read -ra list <<< "$1"
  for tag in "${list[@]}"; do [[ "$tag" == tree-* ]] || return 0; done
  return 1
}

# Children of every version that carries a deploy tag (no cap: rollbacks too).
PROTECTED=""
while IFS=$'\t' read -r _id digest _created tags; do
  [ -n "$tags" ] || continue
  if has_deploy_tag "$tags"; then
    raw=$($IMAGETOOLS inspect --raw "$IMAGE@$digest" 2>/dev/null) || { echo "::error::cannot inspect $IMAGE@$digest — stopping, nothing deleted"; exit 1; }
    PROTECTED+=$(jq -r '(.manifests // [])[].digest' <<< "$raw")$'\n'
  fi
done <<< "$VERSIONS"

DELETE=()
kept=0
while IFS=$'\t' read -r id digest created tags; do
  [ -n "$tags" ] || continue                                        # untagged: never
  if has_deploy_tag "$tags"; then continue; fi                      # a deploy tag: keep
  ts=$(date -d "$created" +%s)
  if [ "$ts" -ge "$CUTOFF" ]; then kept=$((kept + 1)); continue; fi  # recent: keep
  if grep -qxF "$digest" <<< "$PROTECTED"; then kept=$((kept + 1)); continue; fi
  DELETE+=("$id $digest $tags")
done <<< "$VERSIONS"

TOTAL=$(wc -l <<< "$VERSIONS")
echo "$PKG: $TOTAL versions, ${#DELETE[@]} old tree-only to delete, $kept tree-only kept (recent or referenced)."
for line in "${DELETE[@]}"; do
  read -r id digest tags <<< "$line"
  if [ "$MODE" = --apply ]; then
    $GH api -X DELETE "$API/$id" > /dev/null
    echo "deleted $id $tags"
  else
    echo "would delete $id $tags"
  fi
done
if [ "$MODE" = --apply ]; then
  echo "::notice title=GHCR clean-up $PKG::deleted ${#DELETE[@]} of $TOTAL versions"
else
  echo "::notice title=GHCR clean-up $PKG (dry run)::would delete ${#DELETE[@]} of $TOTAL versions; $kept tree-only kept"
fi
