#!/usr/bin/env bash
# Build once: reuse the image the merged pull request's own CI built and tested.
#
# CI pushes each tested web/worker image of a same-repository PR into dev or
# uat and records "<git tree of the tested merge commit> <image@digest>" in a
# run artifact (tested-image-<name>). After the squash merge, this script finds
# that PR (the merge commit's pull request), its successful CI run for the PR's
# head commit, and the artifact. Only when the recorded tree equals the tree of
# the commit being deployed is the image tagged sha-<7> — by digest, so a tag
# pushed later by another PR cannot be picked up. Anything else (dev moved
# before the merge, no artifact, prod, any API error) builds as before.
#
# Usage: reuse-image.sh <image> <env> <commit sha> <target tag> <artifact name>
# Needs GH_TOKEN (contents + actions read) and GITHUB_REPOSITORY.
# Prints reused=true|false (also to $GITHUB_OUTPUT). Fails only on bad arguments.
# GH and IMAGETOOLS override `gh` and `docker buildx imagetools` (tests).
set -euo pipefail

IMAGE="${1:-}"
ENVIRONMENT="${2:-}"
SHA="${3:-}"
TAG="${4:-}"
ARTIFACT="${5:-}"
GH="${GH:-gh}"
IMAGETOOLS="${IMAGETOOLS:-docker buildx imagetools}"
REPO="${GITHUB_REPOSITORY:-}"

out() {
  echo "reused=$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "reused=$1" >> "$GITHUB_OUTPUT"; fi
}
build() { echo "$1 — building."; out false; exit 0; }

if ! [[ "$IMAGE" =~ ^ghcr\.io/[a-z0-9._/-]+$ ]]; then echo "::error::bad image '$IMAGE'"; exit 1; fi
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then echo "::error::bad commit '$SHA'"; exit 1; fi
if ! [[ "$TAG" =~ ^sha-[0-9a-f]{7}$ ]]; then echo "::error::bad tag '$TAG'"; exit 1; fi
if ! [[ "$ARTIFACT" =~ ^tested-image-[a-z]+$ ]]; then echo "::error::bad artifact name '$ARTIFACT'"; exit 1; fi
if ! [[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then echo "::error::GITHUB_REPOSITORY not set"; exit 1; fi

case "$ENVIRONMENT" in dev|uat) ;; *) build "No image reuse for '$ENVIRONMENT'" ;; esac

TREE=$(git rev-parse "$SHA^{tree}" 2>/dev/null) || build "Cannot read the tree of $SHA"

# The pull request this commit merged, and its head commit.
HEAD_SHA=$($GH api "repos/$REPO/commits/$SHA/pulls" \
  --jq "[.[] | select(.merged_at != null and .base.ref == \"$ENVIRONMENT\" and .head.repo.full_name == \"$REPO\")][0].head.sha // empty" 2>/dev/null) || HEAD_SHA=""
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || build "No merged same-repository pull request for $SHA"

# That pull request's successful CI run.
RUN_ID=$($GH api "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&event=pull_request&status=success" \
  --jq '[.workflow_runs[] | select(.path == ".github/workflows/ci.yml")][0].id // empty' 2>/dev/null) || RUN_ID=""
[[ "$RUN_ID" =~ ^[0-9]+$ ]] || build "No successful CI run for ${HEAD_SHA:0:7}"

DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
$GH run download "$RUN_ID" --repo "$REPO" --name "$ARTIFACT" --dir "$DIR" > /dev/null 2>&1 || build "No $ARTIFACT in CI run $RUN_ID"
read -r TESTED_TREE DIGEST_REF < "$DIR/image.txt" || build "Unreadable $ARTIFACT"

[ "$TESTED_TREE" = "$TREE" ] || build "CI tested tree ${TESTED_TREE:0:12}, this commit is ${TREE:0:12} (dev moved before the merge)"
DIGEST="${DIGEST_REF#"$IMAGE@sha256:"}"
[[ "$DIGEST_REF" == "$IMAGE@sha256:"* && "$DIGEST" =~ ^[0-9a-f]{64}$ ]] || build "Unexpected image reference '$DIGEST_REF'"

$IMAGETOOLS create --tag "$IMAGE:$TAG" "$DIGEST_REF" || build "Could not tag $DIGEST_REF"
echo "Reusing $DIGEST_REF (tested in CI run $RUN_ID) as $IMAGE:$TAG."
out true
