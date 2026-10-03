#!/usr/bin/env bash
# Refuse a manual Deploy run whose target environment does not match its branch.
#
# Why: GitHub's "Run workflow" form lets anyone pick the branch and the
# environment independently. Without this check, branch `dev` + environment
# `prod` would build dev's code and deploy it (with migrations) to production.
#
# Allowed pairs: dev → dev, uat → uat, main → prod. Push events are not checked
# here: deploy.yml maps the pushed branch to its environment itself.
#
# Usage: check-deploy-target.sh <event_name> <branch> <environment input>
set -euo pipefail

EVENT="${1:-}"
BRANCH="${2:-}"
TARGET="${3:-}"

if [ "$EVENT" != "workflow_dispatch" ]; then
  echo "Event '$EVENT' — branch decides the environment; nothing to check."
  exit 0
fi

case "$BRANCH" in
  dev)  EXPECTED=dev ;;
  uat)  EXPECTED=uat ;;
  main) EXPECTED=prod ;;
  *)
    echo "::error::Manual deploys run only from dev, uat or main (got branch '$BRANCH')."
    exit 1
    ;;
esac

if [ "$TARGET" != "$EXPECTED" ]; then
  echo "::error::Branch '$BRANCH' deploys only to '$EXPECTED' (requested '$TARGET'). Pick the matching branch in the Run workflow form."
  exit 1
fi

echo "OK: branch '$BRANCH' → environment '$TARGET'."
