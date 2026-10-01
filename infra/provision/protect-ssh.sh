#!/usr/bin/env bash
# infra/provision/protect-ssh.sh
# Keeps sshd available for deploys while the server is under constant
# brute-force scanning (thousands of failed logins per day).
#
# Problem it solves: bots fill sshd's unauthenticated slots (MaxStartups
# 10:30:100, LoginGraceTime 120 s), so sshd randomly drops new connections,
# including GitHub Actions deploys ("Connection reset by peer").
#
# What it does (idempotent, safe to re-run):
#   • sshd drop-in 01-cherrio-capacity.conf:
#       LoginGraceTime 20        → a bot holds a slot 20 s, not 120 s
#       MaxStartups 30:30:120    → more room for unauthenticated handshakes
#       PerSourceMaxStartups 3   → one IP can hold at most 3 slots
#   • fail2ban: sshd jail stricter + recidive jail (repeat offenders, 1 week)
#   • Validates with sshd -t, reloads, asserts the live config.
#
# Password auth is already off (harden-ssh.sh); this is about availability.
# Keep your current SSH session open until a NEW login works.
#
# Usage (on the server, after: bash infra/sync.sh --live):
#   sudo bash /opt/cherrio/infra/provision/protect-ssh.sh
set -euo pipefail

log()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
ok()   { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✓ $*"; }
die()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✗ $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "Must be run as root (sudo)."

###############################################################################
# 1. sshd capacity settings
###############################################################################
SSHD_CONF="/etc/ssh/sshd_config.d/01-cherrio-capacity.conf"
log "Writing ${SSHD_CONF}"
tee "${SSHD_CONF}" > /dev/null <<'CONF'
# CHERR.IO — keep sshd reachable under brute-force scanning (protect-ssh.sh)
LoginGraceTime 20
MaxStartups 30:30:120
PerSourceMaxStartups 3
CONF

if ! sshd -t 2>&1; then
  rm -f "${SSHD_CONF}"
  die "sshd -t failed. ${SSHD_CONF} removed. No changes applied."
fi
ok "sshd -t passed"

systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null \
  || die "Could not reload sshd"
sleep 1
ok "sshd reloaded"

EFFECTIVE=$(sshd -T 2>/dev/null)
check() {
  local key="$1" expected="$2" actual
  actual=$(echo "$EFFECTIVE" | grep -i "^${key} " | cut -d' ' -f2-)
  [[ "$actual" == "$expected" ]] || die "Expected ${key}=${expected}, got '${actual}'."
  ok "${key} = ${actual}"
}
check logingracetime 20
check maxstartups 30:30:120
check persourcemaxstartups 3
check passwordauthentication no
check permitrootlogin no

###############################################################################
# 2. fail2ban: stricter sshd jail + recidive
###############################################################################
JAIL="/etc/fail2ban/jail.d/cherrio.conf"
log "Writing ${JAIL}"
tee "${JAIL}" > /dev/null <<'CONF'
# CHERR.IO — managed by infra/provision/protect-ssh.sh
[sshd]
enabled  = true
mode     = aggressive
maxretry = 3
findtime = 3600
bantime  = 86400

[recidive]
enabled  = true
backend  = auto
logpath  = /var/log/fail2ban.log
findtime = 86400
maxretry = 3
bantime  = 604800
CONF

fail2ban-client -t > /dev/null || die "fail2ban config test failed — check ${JAIL}"
systemctl restart fail2ban
sleep 2
fail2ban-client status sshd > /dev/null || die "sshd jail not running"
fail2ban-client status recidive > /dev/null || die "recidive jail not running"
ok "fail2ban: sshd (aggressive, 24 h ban) and recidive (1 week) active"

log ""
log "=== Done. Before closing this session, open a NEW terminal and run: ssh deploy@49.13.63.71 'echo ok' ==="
