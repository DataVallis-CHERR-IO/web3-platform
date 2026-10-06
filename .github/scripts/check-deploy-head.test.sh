#!/usr/bin/env bash
# Tests for check-deploy-head.sh. Fails (exit 1) if any case is wrong.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

fail=0
expect() {
  local want="$1"; shift
  if bash ./check-deploy-head.sh "$@" >/dev/null 2>&1; then got=pass; else got=fail; fi
  if [ "$got" = "$want" ]; then
    echo "ok   $want: $*"
  else
    echo "FAIL expected $want, got $got: $*"
    fail=1
  fi
}

A=2e0cba667c7852affd35a580457c006795e68123
B=9177277fca31653928138f7e31aad9c006c00457
expect pass "$A" "$A"
# A re-run of an older run after the branch moved
expect fail "$B" "$A"
# Branch head could not be read (ls-remote failed, empty output) → fail closed
expect fail "$A" ""
expect fail "$A" "not-a-sha"
# No commit for the run
expect fail "" "$A"
# Short SHAs are not accepted (they could match more than one commit)
expect fail "${A:0:7}" "$A"

exit $fail
