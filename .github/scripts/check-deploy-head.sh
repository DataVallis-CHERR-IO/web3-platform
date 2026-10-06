#!/usr/bin/env bash
# Refuse a Deploy run whose commit is no longer the head of its branch.
#
# Why: "Re-run jobs" on an old Deploy run would build and ship that old commit
# again — a silent downgrade (and its migrations are already ahead of it).
# A run for the current head passes; anything else fails (exit 1, never skip).
# Rollback is a revert commit (or `kamal rollback` by David), not a re-run.
#
# Usage: check-deploy-head.sh <run commit sha> <current branch head sha>
set -euo pipefail

RUN_SHA="${1:-}"
HEAD_SHA="${2:-}"

if ! [[ "$RUN_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::No valid commit for this run ('$RUN_SHA')."
  exit 1
fi
if ! [[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::Could not read the branch head ('$HEAD_SHA') — refusing to deploy (fail closed)."
  exit 1
fi
if [ "$RUN_SHA" != "$HEAD_SHA" ]; then
  echo "::error::This run is for ${RUN_SHA:0:7}, but the branch is now at ${HEAD_SHA:0:7}. A newer deploy owns the branch; an old run (e.g. a re-run) must not ship older code. To roll back, revert the commit."
  exit 1
fi
echo "OK: ${RUN_SHA:0:7} is the head of the branch."
