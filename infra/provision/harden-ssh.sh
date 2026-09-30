#!/usr/bin/env bash
# infra/provision/harden-ssh.sh
# Hardens SSH config on the server.
# IMPORTANT: Run ONLY after David confirms `ssh deploy@49.13.63.71` works
# AND `sudo -v` succeeds. Keep your current root session open until you
# verify that a new login works.
#
# Safety guarantees:
#   • Refuses to run unless deploy's authorized_keys is present & non-empty
#   • Refuses to run unless deploy has sudo access
#   • Deletes the new conf file if sshd -t validation fails
#   • Asserts the effective config (sshd -T) after reload; dies if wrong
#   • Names the conf file 00-... so it wins over cloud-init's 50-cloud-init.conf
#
# Usage: sudo bash harden-ssh.sh
set -euo pipefail

log()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
ok()   { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✓ $*"; }
die()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✗ $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "Must be run as root."

###############################################################################
# Pre-flight guards
###############################################################################
log "Pre-flight: checking deploy user is ready..."

DEPLOY_AK="/home/deploy/.ssh/authorized_keys"
[[ -f "$DEPLOY_AK" ]] || die "deploy authorized_keys not found at ${DEPLOY_AK}. " \
  "Run provision.sh first and confirm ssh deploy@... works."
[[ -s "$DEPLOY_AK" ]] || die "deploy authorized_keys is empty. " \
  "Confirm 'ssh deploy@49.13.63.71' works before hardening SSH."
ok "deploy authorized_keys exists and is non-empty"

if ! sudo -l -U deploy 2>/dev/null | grep -q 'NOPASSWD: ALL'; then
  die "deploy does not have passwordless sudo. Run provision.sh first."
fi
ok "deploy has passwordless sudo"

###############################################################################
# Write hardening config
# Named 00-... so it is parsed BEFORE cloud-init's 50-cloud-init.conf,
# which sets 'PasswordAuthentication yes'. sshd uses the first match.
###############################################################################
SSHD_CONF="/etc/ssh/sshd_config.d/00-cherrio-hardening.conf"
log "Writing SSH hardening config to ${SSHD_CONF}"
tee "${SSHD_CONF}" > /dev/null <<'EOF'
# CHERR.IO SSH hardening — must be named 00-* to win over cloud-init 50-* file
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
MaxAuthTries 3
EOF
ok "Config written"

###############################################################################
# Validate — clean up and abort on failure
###############################################################################
log "Validating with sshd -t..."
if ! sshd -t 2>&1; then
  log "Validation failed — deleting ${SSHD_CONF} to avoid applying on reboot"
  rm -f "${SSHD_CONF}"
  die "sshd -t failed. Config deleted. No changes applied."
fi
ok "sshd -t passed"

###############################################################################
# Reload
###############################################################################
log "Reloading sshd..."
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null \
  || die "Could not reload sshd"
sleep 1   # brief pause so sshd applies the new config
ok "sshd reloaded"

###############################################################################
# Assert effective configuration (sshd -T reads the live running config)
###############################################################################
log "Asserting effective sshd config..."
EFFECTIVE=$(sshd -T 2>/dev/null | grep -iE '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication) ')
echo "$EFFECTIVE"

check_setting() {
  local key="$1" expected="$2"
  local actual
  actual=$(echo "$EFFECTIVE" | grep -i "^${key} " | awk '{print tolower($2)}')
  if [[ "$actual" != "$expected" ]]; then
    die "Expected ${key}=${expected} but got '${actual}'. " \
        "Check /etc/ssh/sshd_config and sshd_config.d/ for conflicting files."
  fi
  ok "${key} = ${actual}"
}

check_setting permitrootlogin          no
check_setting passwordauthentication   no
check_setting kbdinteractiveauthentication no

###############################################################################
# Done
###############################################################################
log ""
log "=== SSH hardening applied and verified ==="
log ""
log "Root login: DISABLED   Password auth: DISABLED"
log ""
log "IMPORTANT: Before closing this session, open a NEW terminal and verify:"
log "  ssh deploy@49.13.63.71"
log ""
log "If locked out, use Hetzner console — see infra/README.md §Recovery."
