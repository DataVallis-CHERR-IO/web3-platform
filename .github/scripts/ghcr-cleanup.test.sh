#!/usr/bin/env bash
# Tests for ghcr-cleanup.sh with fake `gh` and `imagetools` (no network, no registry).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/gh" <<'FAKE'
#!/usr/bin/env bash
echo "gh $*" >> "$CALLS"
if [ "$1" = api ] && [ "$2" = --paginate ]; then
  [ -z "${DEPLOY_BUSY_AFTER_LIST:-}" ] || touch "$BUSY_FLAG"
  cat "$VERSIONS_FILE"; exit 0
fi
if [ "$1" = api ] && [[ "$2" == *deploy.yml/runs?status=success* ]]; then echo 9999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; exit 0; fi
if [ "$1" = api ] && [[ "$2" == *deploy.yml/runs?status=* ]]; then
  if [ -n "${DEPLOY_BUSY:-}" ] && { [ -n "${BUSY_FLAG_PRESET:-}" ] || [ -f "$BUSY_FLAG" ]; }; then echo 1; else echo 0; fi
  exit 0
fi
if [ "$1" = api ] && [[ "$2" == *commits?sha=main* ]]; then
  [ -z "${MAIN_FAILS:-}" ] || { echo "gh: Server Error (HTTP 502)" >&2; exit 1; }
  echo 7777777aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; exit 0
fi
if [ "$1" = api ] && [[ "$2" == *commits?sha=uat* ]]; then echo "gh: Branch not found (HTTP 404)" >&2; exit 1; fi
if [ "$1" = api ] && [ "$2" = -X ] && [ "$3" = DELETE ]; then exit 0; fi
exit 1
FAKE
cat > "$WORK/imagetools" <<'FAKE'
#!/usr/bin/env bash
echo "imagetools $*" >> "$CALLS"
d="${3##*@sha256:}"
[ "${INSPECT_FAILS:-}" != "$d" ] || exit 1
idx() { printf '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[%s]}\n' "$1"; }
case "$d" in
  idx1) idx '{"digest":"sha256:c1"},{"digest":"sha256:t1"}' ;;
  t1) idx '{"digest":"sha256:g1"}' ;;
  idx99) idx '{"digest":"sha256:c99"}' ;;
  idx[2-5]) idx "{\"digest\":\"sha256:c${d#idx}\"}" ;;
  idx6) idx '{"digest":"sha256:c6"},{"digest":"sha256:t6"}' ;;
  idx7) idx '{"digest":"sha256:c7"}' ;;
  latest) idx '{"digest":"sha256:c8"}' ;;
  *) echo '{"mediaType":"application/vnd.docker.distribution.manifest.v2+json","layers":[]}' ;;
esac
FAKE
chmod +x "$WORK/gh" "$WORK/imagetools"

NOW=$(date -d 2026-10-09T12:00:00Z +%s)
T=$'\t'
# Deliberately not sorted. With KEEP_DEPLOYS=5: deploys 1–5 are the newest five (kept with
# their children); 6 is old and beyond five → deleted with its children c6 and t6; 7 is
# old and beyond five but sha-7777777 is a main commit → kept; 99 is the oldest but
# sha-9999999 is a recent successful Deploy run (an old digest deployed again) → kept;
# "latest" (unknown tag) → kept; t1 (child of 1) is itself an index → its child g1 kept;
# old orphans (untagged u9, tree-only t11) → deleted; recent orphans (u10, t12) → kept.
cat > "$WORK/versions" <<EOF
6${T}sha256:idx6${T}2026-08-01T10:00:00Z${T}sha-6666666
1${T}sha256:idx1${T}2026-10-09T10:00:00Z${T}sha-1111111
101${T}sha256:c1${T}2026-10-09T09:59:00Z${T}
102${T}sha256:t1${T}2026-10-01T10:00:00Z${T}tree-dev-aaaa
2${T}sha256:idx2${T}2026-09-04T10:00:00Z${T}sha-2222222
3${T}sha256:idx3${T}2026-09-03T10:00:00Z${T}sha-3333333,tree-dev-bbbb
4${T}sha256:idx4${T}2026-09-02T10:00:00Z${T}sha-4444444
5${T}sha256:idx5${T}2026-09-01T10:00:00Z${T}sha-5555555
202${T}sha256:c2${T}2026-09-04T09:59:00Z${T}
203${T}sha256:c3${T}2026-09-03T09:59:00Z${T}
204${T}sha256:c4${T}2026-09-02T09:59:00Z${T}
205${T}sha256:c5${T}2026-09-01T09:59:00Z${T}
601${T}sha256:c6${T}2026-08-01T09:59:00Z${T}
602${T}sha256:t6${T}2026-07-30T10:00:00Z${T}tree-dev-ffff
7${T}sha256:idx7${T}2026-07-01T10:00:00Z${T}sha-7777777
701${T}sha256:c7${T}2026-07-01T09:59:00Z${T}
8${T}sha256:latest${T}2026-06-01T10:00:00Z${T}latest
801${T}sha256:c8${T}2026-06-01T09:59:00Z${T}
9${T}sha256:u9${T}2026-06-01T10:00:00Z${T}
10${T}sha256:u10${T}2026-10-05T10:00:00Z${T}
11${T}sha256:t11${T}2026-09-01T10:00:00Z${T}tree-dev-1111
12${T}sha256:t12${T}2026-10-01T10:00:00Z${T}tree-uat-2222
13${T}sha256:g1${T}2026-06-01T10:00:00Z${T}
99${T}sha256:idx99${T}2026-05-01T10:00:00Z${T}sha-9999999
9901${T}sha256:c99${T}2026-05-01T09:59:00Z${T}
EOF

FAIL=0
run() { # want-exit want-text env... -- args...
  local want_code="$1" want_out="$2"; shift 2
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  : > "$WORK/calls"; rm -f "$WORK/busy"
  local got code
  got=$(env CALLS="$WORK/calls" VERSIONS_FILE="$WORK/versions" GH="$WORK/gh" IMAGETOOLS="$WORK/imagetools" \
    CLEANUP_NOW="$NOW" GITHUB_REPOSITORY=o/r KEEP_DEPLOYS=5 BUSY_FLAG="$WORK/busy" "${envs[@]}" bash "$DIR/ghcr-cleanup.sh" "$@" 2>&1); code=$?
  if [ "$code" != "$want_code" ] || ! grep -qF -- "$want_out" <<< "$got"; then echo "FAIL ($want_out): exit $code — $got"; FAIL=1; else echo "ok: $want_out"; fi
}
deleted_ids() { grep -oE -- "-X DELETE .*/versions/[0-9]+$" "$WORK/calls" | grep -oE '[0-9]+$' | sort -n | tr '\n' ' '; }

# Dry run: counts, nothing deleted, package name encoded.
run 0 "cherrio/web: 25 versions; deploy images 8 (keep 7); delete 5; other kept" -- DataVallis-CHERR-IO cherrio/web
run 0 "would delete 6 sha-6666666" -- DataVallis-CHERR-IO cherrio/web
[ -z "$(deleted_ids)" ] || { echo "FAIL: dry run deleted $(deleted_ids)"; FAIL=1; }
grep -qF "packages/container/cherrio%2Fweb/versions" "$WORK/calls" || { echo "FAIL: package name not encoded"; FAIL=1; }

# Apply: exactly the old sixth deploy, its two children and the two old orphans.
run 0 "deleted 602 tree-dev-ffff" -- DataVallis-CHERR-IO cherrio/web --apply
[ "$(deleted_ids)" = "6 9 11 601 602 " ] || { echo "FAIL: deleted '$(deleted_ids)', want '6 9 11 601 602 '"; FAIL=1; }

# More deploys kept → only the orphans go; the main commit keeps 7 even with the minimum.
run 0 "deploy images 8 (keep 8); delete 2" KEEP_DEPLOYS=6 -- DataVallis-CHERR-IO cherrio/web --apply
[ "$(deleted_ids)" = "9 11 " ] || { echo "FAIL: deleted '$(deleted_ids)', want '9 11 '"; FAIL=1; }

# A recent deploy beyond the newest KEEP_DEPLOYS is deleted too ("keep the last 20", not "21 days"):
# deploys 2–5 move to October and 6 to 2026-09-30 (inside the 21-day window) — 6 is still the sixth.
sed -e 's/sha256:idx\([2-5]\)\(.\)2026-09-0/sha256:idx\1\22026-10-0/' -e 's/sha256:idx6\(.\)2026-08-01/sha256:idx6\12026-09-30/' "$WORK/versions" > "$WORK/v2"
mv "$WORK/v2" "$WORK/versions"
run 0 "deploy images 8 (keep 7); delete 5" -- DataVallis-CHERR-IO cherrio/web --apply
[ "$(deleted_ids)" = "6 9 11 601 602 " ] || { echo "FAIL: recent sixth deploy: deleted '$(deleted_ids)'"; FAIL=1; }

# Any unreadable index stops the run before a single delete.
for d in idx6 idx2 latest; do
  run 1 "cannot inspect ghcr.io/datavallis-cherr-io/cherrio/web@sha256:$d" "INSPECT_FAILS=$d" -- DataVallis-CHERR-IO cherrio/web --apply
  [ -z "$(deleted_ids)" ] || { echo "FAIL: deleted after inspect failure of $d"; FAIL=1; }
done

# A Deploy that runs, or starts during the clean-up, stops it; GitHub errors stop it.
run 1 "a Deploy run is queued or in progress" DEPLOY_BUSY=1 BUSY_FLAG_PRESET=1 -- DataVallis-CHERR-IO cherrio/web --apply
run 1 "a Deploy run started — nothing deleted" DEPLOY_BUSY=1 DEPLOY_BUSY_AFTER_LIST=1 -- DataVallis-CHERR-IO cherrio/web --apply
[ -z "$(deleted_ids)" ] || { echo "FAIL: deleted while a Deploy started"; FAIL=1; }
run 1 "cannot read the commits of main" MAIN_FAILS=1 -- DataVallis-CHERR-IO cherrio/web --apply
[ -z "$(deleted_ids)" ] || { echo "FAIL: deleted after a main lookup failure"; FAIL=1; }

# Bad arguments.
run 1 "bad package" -- DataVallis-CHERR-IO 'web;rm' --apply
run 1 "bad package" -- DataVallis-CHERR-IO cherrio-site --apply
run 1 "unknown option" -- DataVallis-CHERR-IO cherrio/web --force
run 1 "KEEP_DAYS must be" KEEP_DAYS=0 -- DataVallis-CHERR-IO cherrio/web
run 1 "KEEP_DEPLOYS must be" KEEP_DEPLOYS=2 -- DataVallis-CHERR-IO cherrio/web
exit $FAIL
