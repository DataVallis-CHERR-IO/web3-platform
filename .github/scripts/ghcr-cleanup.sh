#!/usr/bin/env bash
# GHCR clean-up for cherrio/web, cherrio/worker and cherrio/indexer (private
# packages, storage costs money). Two kinds of images pile up:
#
#   Deploy images — tagged sha-<7> by Deploy. A built image is an index with
#   untagged children (platform manifest + attestations); a reused tested image
#   (build once, PR #183) is a new index whose child is the tree-* image.
#   Tested images — <image>:tree-<base>-<tree>, pushed by CI for every PR run.
#
# Kept (David 2026-10-09: "ja uredi to" — keep the last 20 deploys):
#   - the KEEP_DEPLOYS (20) newest deploy images, by the later of created_at and
#     updated_at (re-tagging an existing digest only moves updated_at);
#   - every deploy image whose sha-<7> belongs to one of the last 50 successful
#     Deploy runs (the running image and recent rollback targets, even when an
#     old digest was deployed again), or to one of the last 50 commits of main
#     or uat (production / acceptance must stay deployable);
#   - every image with a tag that is neither sha-<7> nor tree-* (unknown use);
#   - tree-* and untagged images created in the last KEEP_DAYS (21 — longer than
#     the 14-day retention of the tested-image artifact, so Deploy can never pick
#     one), unless they belong to a deleted deploy image;
#   - every child of a kept index.
# Deleted: the other deploy images and their children, old tree-only images
# and old untagged images that no kept index references. An index that cannot
# be read, a failing GitHub lookup (other than a missing uat branch) or a Deploy
# run that is queued or in progress stops the run before anything is deleted.
# Tested (tree-*) images are followed one level further in case they are an
# index themselves.
#
# Usage: ghcr-cleanup.sh <org> <package> [--apply]   (without --apply: dry run)
# Needs GH_TOKEN (packages write, contents read), GITHUB_REPOSITORY and
# `docker login ghcr.io`. GH, IMAGETOOLS and CLEANUP_NOW (epoch seconds)
# override `gh`, `docker buildx imagetools` and the clock (tests).
set -euo pipefail
ORG="${1:-}"
PKG="${2:-}"
MODE="${3:-}"
GH="${GH:-gh}"
IMAGETOOLS="${IMAGETOOLS:-docker buildx imagetools}"
KEEP_DAYS="${KEEP_DAYS:-21}"
KEEP_DEPLOYS="${KEEP_DEPLOYS:-20}"
REPO="${GITHUB_REPOSITORY:-}"
NOW="${CLEANUP_NOW:-$(date +%s)}"

if ! [[ "$ORG" =~ ^[A-Za-z0-9-]+$ ]]; then echo "::error::bad org '$ORG'"; exit 1; fi
case "$PKG" in cherrio/web|cherrio/worker|cherrio/indexer) ;; *) echo "::error::bad package '$PKG'"; exit 1 ;; esac
case "$MODE" in ""|--apply) ;; *) echo "::error::unknown option '$MODE'"; exit 1 ;; esac
if ! [[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || [ "$KEEP_DAYS" -lt 1 ]; then echo "::error::KEEP_DAYS must be ≥ 1"; exit 1; fi
if ! [[ "$KEEP_DEPLOYS" =~ ^[0-9]+$ ]] || [ "$KEEP_DEPLOYS" -lt 5 ]; then echo "::error::KEEP_DEPLOYS must be ≥ 5"; exit 1; fi
if ! [[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then echo "::error::GITHUB_REPOSITORY not set"; exit 1; fi

ENC="${PKG//\//%2F}"
IMAGE="ghcr.io/$(echo "$ORG" | tr '[:upper:]' '[:lower:]')/$PKG"
API="orgs/$ORG/packages/container/$ENC/versions"
CUTOFF=$((NOW - KEEP_DAYS * 86400))

deploy_busy() {
  local n state
  for state in queued in_progress waiting; do
    n=$($GH api "repos/$REPO/actions/workflows/deploy.yml/runs?status=$state&per_page=1" --jq '.total_count') \
      || { echo "::error::cannot read Deploy runs — stopping, nothing deleted"; exit 1; }
    [ "$n" = 0 ] || return 0
  done
  return 1
}
if deploy_busy; then echo "::error::a Deploy run is queued or in progress — run the clean-up later; nothing deleted"; exit 1; fi

# One line per version: newest(epoch of max(created_at, updated_at)) <TAB> id <TAB> digest <TAB> tags, newest first.
RAW=$($GH api --paginate "$API?per_page=100" \
  --jq '.[] | [.id, .name, ([.created_at, (.updated_at // .created_at)] | max), ((.metadata.container.tags // []) | join(","))] | @tsv')
[ -n "$RAW" ] || { echo "No versions in $PKG."; exit 0; }
VERSIONS=$(while IFS=$'\t' read -r id digest when tags; do
  printf '%s\t%s\t%s\t%s\n' "$(date -d "$when" +%s)" "$id" "$digest" "$tags"
done <<< "$RAW" | sort -t$'\t' -k1,1nr)

# sha-<7> tags that must stay: the last 50 successful Deploy runs, the last 50
# commits of main and uat. Only a missing uat branch may be skipped.
to_tags() { sed -E 's/^(.{7}).*/sha-\1/'; }
PROTECT_TAGS=$($GH api "repos/$REPO/actions/workflows/deploy.yml/runs?status=success&per_page=50" --jq '.workflow_runs[].head_sha' | to_tags) \
  || { echo "::error::cannot read successful Deploy runs — stopping, nothing deleted"; exit 1; }
PROTECT_TAGS+=$'\n'
for branch in main uat; do
  if out=$($GH api "repos/$REPO/commits?sha=$branch&per_page=50" --jq '.[].sha' 2>&1); then
    PROTECT_TAGS+=$(to_tags <<< "$out")$'\n'
  elif [ "$branch" = uat ] && grep -qiE 'HTTP 404|not found' <<< "$out"; then
    :
  else
    echo "::error::cannot read the commits of $branch — stopping, nothing deleted"; exit 1
  fi
done

kind_of() { # deploy | tree | other | untagged
  local tag kind="" ; local -a list
  [ -n "$1" ] || { echo untagged; return; }
  IFS=, read -ra list <<< "$1"
  for tag in "${list[@]}"; do
    if [[ "$tag" =~ ^sha-[0-9a-f]{7}$ ]]; then kind=deploy
    elif [[ "$tag" != tree-* ]]; then echo other; return
    fi
  done
  echo "${kind:-tree}"
}
protected_tag() { # any of the tags belongs to a recent Deploy run or a main/uat commit
  local tag; local -a list
  IFS=, read -ra list <<< "$1"
  for tag in "${list[@]}"; do grep -qxF "$tag" <<< "$PROTECT_TAGS" && return 0; done
  return 1
}
# Digests of tested (tree-*) images: if one of them is a child, it is followed one level further.
TREE_DIGESTS=$(while IFS=$'\t' read -r _ts _id digest tags; do [[ "$tags" == *tree-* ]] && echo "$digest"; done <<< "$VERSIONS" || true)
inspect_children() {
  local raw
  raw=$($IMAGETOOLS inspect --raw "$IMAGE@$1" 2>/dev/null) || { echo "::error::cannot inspect $IMAGE@$1 — stopping, nothing deleted" >&2; return 1; }
  jq -r '(.manifests // [])[].digest' <<< "$raw"
}
children_of() {
  local child grand
  grand=$(inspect_children "$1") || return 1
  echo "$grand"
  while read -r child; do
    [ -n "$child" ] || continue
    if grep -qxF "$child" <<< "$TREE_DIGESTS"; then inspect_children "$child" || return 1; fi
  done <<< "$grand"
}

# Pass 1: decide the deploy and other tagged images; collect children of kept and dropped indexes.
KEEP_SET=""; KEPT_CHILDREN=""; DROPPED_CHILDREN=""
DELETE=()
deploys=0; kept_deploys=0
while IFS=$'\t' read -r ts id digest tags; do
  kind=$(kind_of "$tags")
  case "$kind" in
    other)
      KEEP_SET+="$digest"$'\n'
      KEPT_CHILDREN+=$(children_of "$digest")$'\n' || exit 1 ;;
    deploy)
      deploys=$((deploys + 1))
      if [ "$deploys" -le "$KEEP_DEPLOYS" ] || protected_tag "$tags"; then
        kept_deploys=$((kept_deploys + 1))
        KEEP_SET+="$digest"$'\n'
        KEPT_CHILDREN+=$(children_of "$digest")$'\n' || exit 1
      else
        DROPPED_CHILDREN+=$(children_of "$digest")$'\n' || exit 1
        DELETE+=("$id $digest $tags")
      fi ;;
  esac
done <<< "$VERSIONS"

# Pass 2: tree-only and untagged images.
kept_other=0
while IFS=$'\t' read -r ts id digest tags; do
  kind=$(kind_of "$tags")
  case "$kind" in tree|untagged) ;; *) continue ;; esac
  if grep -qxF "$digest" <<< "$KEPT_CHILDREN"; then kept_other=$((kept_other + 1)); continue; fi
  if grep -qxF "$digest" <<< "$DROPPED_CHILDREN"; then DELETE+=("$id $digest ${tags:-untagged}"); continue; fi
  if [ "$ts" -ge "$CUTOFF" ]; then kept_other=$((kept_other + 1)); continue; fi
  DELETE+=("$id $digest ${tags:-untagged}")
done <<< "$VERSIONS"

# Never delete what a kept image is or needs (a dropped image can also be a kept index's child).
FINAL=()
for line in "${DELETE[@]}"; do
  read -r _id digest _tags <<< "$line"
  if grep -qxF "$digest" <<< "$KEEP_SET" || grep -qxF "$digest" <<< "$KEPT_CHILDREN"; then continue; fi
  FINAL+=("$line")
done
DELETE=("${FINAL[@]}")
# A Deploy may have started while this ran: check again just before deleting.
if [ "$MODE" = --apply ] && deploy_busy; then echo "::error::a Deploy run started — nothing deleted"; exit 1; fi

TOTAL=$(wc -l <<< "$VERSIONS")
echo "$PKG: $TOTAL versions; deploy images $deploys (keep $kept_deploys); delete ${#DELETE[@]}; other kept $kept_other."
for line in "${DELETE[@]}"; do
  read -r id _digest tags <<< "$line"
  if [ "$MODE" = --apply ]; then
    $GH api -X DELETE "$API/$id" > /dev/null
    echo "deleted $id $tags"
  else
    echo "would delete $id $tags"
  fi
done
if [ "$MODE" = --apply ]; then
  echo "::notice title=GHCR clean-up $PKG::deleted ${#DELETE[@]} of $TOTAL versions (kept $kept_deploys of $deploys deploy images)"
else
  echo "::notice title=GHCR clean-up $PKG (dry run)::would delete ${#DELETE[@]} of $TOTAL versions (keeps $kept_deploys of $deploys deploy images)"
fi
