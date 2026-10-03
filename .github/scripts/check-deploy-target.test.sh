#!/usr/bin/env bash
# Tests for check-deploy-target.sh. Fails (exit 1) if any case is wrong.
set -uo pipefail
cd "$(dirname "$0")"

fail=0
expect() {
  local want="$1"; shift
  if bash ./check-deploy-target.sh "$@" >/dev/null 2>&1; then got=pass; else got=fail; fi
  if [ "$got" = "$want" ]; then
    echo "ok   $want: $*"
  else
    echo "FAIL expected $want, got $got: $*"
    fail=1
  fi
}

# Matching pairs
expect pass workflow_dispatch dev dev
expect pass workflow_dispatch uat uat
expect pass workflow_dispatch main prod
# Mismatches — the footgun this guard exists for
expect fail workflow_dispatch dev prod
expect fail workflow_dispatch dev uat
expect fail workflow_dispatch uat prod
expect fail workflow_dispatch main dev
expect fail workflow_dispatch main uat
# Branches that never deploy
expect fail workflow_dispatch feat/x dev
expect fail workflow_dispatch hotfix/y prod
# Missing input
expect fail workflow_dispatch main ""
# Push events are not checked here
expect pass push dev ""
expect pass push uat ""

exit $fail
