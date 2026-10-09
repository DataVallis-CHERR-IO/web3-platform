#!/usr/bin/env bash
# Tests for ghcr-cleanup.sh with fake `gh` and `imagetools` (no network, no registry).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/gh" <<'FAKE'
#!/usr/bin/env bash
echo "gh $*" >> "$CALLS"
if [ "$1" = api ] && [ "$2" = --paginate ]; then cat "$VERSIONS_FILE"; exit 0; fi
if [ "$1" = api ] && [ "$2" = -X ] && [ "$3" = DELETE ]; then exit 0; fi
exit 1
FAKE
cat > "$WORK/imagetools" <<'FAKE'
#!/usr/bin/env bash
echo "imagetools $*" >> "$CALLS"
[ "${INSPECT_FAILS:-}" != 1 ] || exit 1
case "$3" in
  *@sha256:idx) echo '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"digest":"sha256:child"},{"digest":"sha256:att"}]}' ;;
  *@sha256:oldidx) echo '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"digest":"sha256:oldchild"}]}' ;;
  *) echo '{"mediaType":"application/vnd.docker.distribution.manifest.v2+json","layers":[]}' ;;
esac
FAKE
chmod +x "$WORK/gh" "$WORK/imagetools"

NOW=$(date -d 2026-10-09T12:00:00Z +%s)
T=$'\t'
# Not sorted on purpose (the API order is not documented). A reused deploy is an
# index tagged sha-* whose child is the tested tree-only version (imagetools create).
# 1: deploy index → child 4; 2: tree + sha on one digest; 3: tree-only, 10 days old
# (inside the 21-day window); 4: old tree-only, child of 1; 5, 6: old tree-only;
# 7: old untagged; 8: old deploy index (a rollback image) → child 9; 9: its old tree-only child.
cat > "$WORK/versions" <<EOF
1${T}sha256:idx${T}2026-10-09T10:00:00Z${T}sha-aaaaaaa
2${T}sha256:reused${T}2026-10-08T10:00:00Z${T}tree-dev-1111,sha-bbbbbbb
3${T}sha256:fresh${T}2026-09-29T10:00:00Z${T}tree-dev-2222
4${T}sha256:child${T}2026-09-01T10:00:00Z${T}tree-dev-3333
5${T}sha256:old1${T}2026-09-10T09:00:00Z${T}tree-dev-4444
6${T}sha256:old2${T}2026-09-09T09:00:00Z${T}tree-uat-5555,tree-dev-6666
7${T}sha256:att${T}2026-09-08T09:00:00Z${T}
8${T}sha256:oldidx${T}2026-08-01T09:00:00Z${T}sha-ccccccc
9${T}sha256:oldchild${T}2026-08-01T08:00:00Z${T}tree-dev-7777
EOF

FAIL=0
run() { # want-exit want-text env... -- args...
  local want_code="$1" want_out="$2"; shift 2
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  : > "$WORK/calls"
  local got code
  got=$(env CALLS="$WORK/calls" VERSIONS_FILE="$WORK/versions" GH="$WORK/gh" IMAGETOOLS="$WORK/imagetools" CLEANUP_NOW="$NOW" "${envs[@]}" bash "$DIR/ghcr-cleanup.sh" "$@" 2>&1); code=$?
  if [ "$code" != "$want_code" ] || ! grep -qF -- "$want_out" <<< "$got"; then echo "FAIL ($want_out): exit $code — $got"; FAIL=1; else echo "ok: $want_out"; fi
}
deletes() { grep -c -- "-X DELETE" "$WORK/calls" || true; }

# Dry run: only 5 and 6 qualify; nothing is deleted.
run 0 "cherrio/web: 9 versions, 2 old tree-only to delete, 3 tree-only kept" -- DataVallis-CHERR-IO cherrio/web
run 0 "would delete 5 tree-dev-4444" -- DataVallis-CHERR-IO cherrio/web
[ "$(deletes)" = 0 ] || { echo "FAIL: dry run deleted"; FAIL=1; }
grep -qF "packages/container/cherrio%2Fweb/versions" "$WORK/calls" || { echo "FAIL: package name not encoded"; FAIL=1; }

# Apply: exactly versions 5 and 6.
run 0 "deleted 6 tree-uat-5555,tree-dev-6666" -- DataVallis-CHERR-IO cherrio/web --apply
[ "$(deletes)" = 2 ] || { echo "FAIL: expected 2 deletes, got $(deletes)"; FAIL=1; }
for id in 1 2 3 4 7 8 9; do
  if grep -qE -- "-X DELETE .*/versions/$id$" "$WORK/calls"; then echo "FAIL: deleted kept version $id"; FAIL=1; fi
done
grep -qF "imagetools inspect --raw ghcr.io/datavallis-cherr-io/cherrio/web@sha256:idx" "$WORK/calls" || { echo "FAIL: index not inspected"; FAIL=1; }
grep -qF "imagetools inspect --raw ghcr.io/datavallis-cherr-io/cherrio/web@sha256:oldidx" "$WORK/calls" || { echo "FAIL: old deploy index not inspected"; FAIL=1; }

# A 7-day window would also take the 10-day-old image (3).
run 0 "3 old tree-only to delete" KEEP_DAYS=7 -- DataVallis-CHERR-IO cherrio/web

# A longer keep window keeps everything.
run 0 "0 old tree-only to delete" KEEP_DAYS=60 -- DataVallis-CHERR-IO cherrio/web --apply
[ "$(deletes)" = 0 ] || { echo "FAIL: KEEP_DAYS=60 deleted"; FAIL=1; }

# If the protecting index cannot be read, stop before deleting anything.
run 1 "stopping, nothing deleted" INSPECT_FAILS=1 -- DataVallis-CHERR-IO cherrio/web --apply
[ "$(deletes)" = 0 ] || { echo "FAIL: deleted after inspect failure"; FAIL=1; }

# Bad arguments.
run 1 "bad package" -- DataVallis-CHERR-IO 'web;rm' --apply
run 1 "bad package" -- DataVallis-CHERR-IO cherrio-site --apply
run 1 "unknown option" -- DataVallis-CHERR-IO cherrio/web --force
run 1 "KEEP_DAYS must be" KEEP_DAYS=0 -- DataVallis-CHERR-IO cherrio/web
exit $FAIL
