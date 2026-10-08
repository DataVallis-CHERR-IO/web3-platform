#!/usr/bin/env bash
# Tests for reuse-image.sh with fake `gh` and `imagetools` (no network, no registry).
# Run from the repository root (uses this checkout's HEAD commit and tree).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/gh" <<'FAKE'
#!/usr/bin/env bash
echo "gh $*" >> "$CALLS"
if [ "$1" = api ] && [[ "$2" == */pulls ]]; then echo "${FAKE_HEAD:-}"; exit 0; fi
if [ "$1" = api ] && [[ "$2" == *actions/runs* ]]; then echo "${FAKE_RUN:-}"; exit 0; fi
if [ "$1" = run ] && [ "$2" = download ]; then
  [ -n "${FAKE_CONTENT:-}" ] || exit 1
  while [ $# -gt 0 ]; do if [ "$1" = --dir ]; then echo "$FAKE_CONTENT" > "$2/image.txt"; fi; shift; done
  exit 0
fi
exit 1
FAKE
cat > "$WORK/imagetools" <<'FAKE'
#!/usr/bin/env bash
echo "imagetools $*" >> "$CALLS"
[ "${CREATE_FAILS:-}" != 1 ]
FAKE
chmod +x "$WORK/gh" "$WORK/imagetools"

IMG=ghcr.io/datavallis-cherr-io/cherrio/web
SHA=$(git rev-parse HEAD)
TREE=$(git rev-parse 'HEAD^{tree}')
HEAD=1111111111111111111111111111111111111111
DIG="$IMG@sha256:$(printf 'a%.0s' {1..64})"
FAIL=0
run() { # want-exit want-text env... -- args...
  local want_code="$1" want_out="$2"; shift 2
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  : > "$WORK/calls"
  local got code
  got=$(env CALLS="$WORK/calls" GH="$WORK/gh" IMAGETOOLS="$WORK/imagetools" GITHUB_REPOSITORY=o/r GITHUB_OUTPUT= "${envs[@]}" bash "$DIR/reuse-image.sh" "$@" 2>&1); code=$?
  if [ "$code" != "$want_code" ] || ! grep -qF -- "$want_out" <<< "$got"; then echo "FAIL ($want_out): exit $code — $got"; FAIL=1; else echo "ok: $want_out"; fi
}
OK=("FAKE_HEAD=$HEAD" FAKE_RUN=42 "FAKE_CONTENT=$TREE $DIG")
run 0 "reused=true" "${OK[@]}" -- "$IMG" dev "$SHA" sha-abc1234 tested-image-web
grep -qF "imagetools create --tag $IMG:sha-abc1234 $DIG" "$WORK/calls" || { echo "FAIL: not tagged by digest"; FAIL=1; }
run 0 "dev moved before the merge" FAKE_HEAD=$HEAD FAKE_RUN=42 "FAKE_CONTENT=0000000000000000000000000000000000000000 $DIG" -- "$IMG" dev "$SHA" sha-abc1234 tested-image-web
run 0 "No merged same-repository pull request" FAKE_RUN=42 "FAKE_CONTENT=$TREE $DIG" -- "$IMG" dev "$SHA" sha-abc1234 tested-image-web
run 0 "No successful CI run" FAKE_HEAD=$HEAD "FAKE_CONTENT=$TREE $DIG" -- "$IMG" dev "$SHA" sha-abc1234 tested-image-web
run 0 "No tested-image-web in CI run 42" FAKE_HEAD=$HEAD FAKE_RUN=42 -- "$IMG" dev "$SHA" sha-abc1234 tested-image-web
run 0 "Unexpected image reference" FAKE_HEAD=$HEAD FAKE_RUN=42 "FAKE_CONTENT=$TREE ghcr.io/evil/web@sha256:$(printf 'a%.0s' {1..64})" -- "$IMG" dev "$SHA" sha-abc1234 tested-image-web
run 0 "Unexpected image reference" FAKE_HEAD=$HEAD FAKE_RUN=42 "FAKE_CONTENT=$TREE $IMG:latest" -- "$IMG" dev "$SHA" sha-abc1234 tested-image-web
run 0 "Could not tag" "${OK[@]}" CREATE_FAILS=1 -- "$IMG" dev "$SHA" sha-abc1234 tested-image-web
run 0 "No image reuse for 'prod'" "${OK[@]}" -- "$IMG" prod "$SHA" sha-abc1234 tested-image-web
run 1 "bad commit" "${OK[@]}" -- "$IMG" dev nope sha-abc1234 tested-image-web
run 1 "bad tag" "${OK[@]}" -- "$IMG" dev "$SHA" latest tested-image-web
run 1 "bad image" "${OK[@]}" -- docker.io/evil/web dev "$SHA" sha-abc1234 tested-image-web
exit $FAIL
