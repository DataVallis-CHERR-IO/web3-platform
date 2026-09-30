#!/usr/bin/env bash
# infra/provision/provision.sh
# Idempotent host bootstrap for cherrio-1.
# Usage: sudo bash provision.sh [--dry-run]
# Must be run as root. Safe to run more than once.
set -euo pipefail

###############################################################################
# Helpers
###############################################################################
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

log()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
ok()   { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✓ $*"; }
warn() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ⚠ $*" >&2; }
die()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ✗ $*" >&2; exit 1; }

run() {
  if $DRY_RUN; then
    echo "[DRY-RUN] $*"
  else
    "$@"
  fi
}

[[ "$(id -u)" -eq 0 ]] || die "Must be run as root."
$DRY_RUN && log "=== DRY-RUN mode — no changes will be made ==="

###############################################################################
# Step 1 — Hostname, timezone, locale
###############################################################################
log "Step 1: hostname / timezone / locale"
CURRENT_HOSTNAME=$(hostname)
if [[ "$CURRENT_HOSTNAME" != "cherrio-1" ]]; then
  run hostnamectl set-hostname cherrio-1
  ok "Hostname set to cherrio-1"
else
  ok "Hostname already cherrio-1"
fi

run timedatectl set-timezone UTC
ok "Timezone UTC"

if ! locale | grep -q 'LANG=en_US.UTF-8'; then
  run locale-gen en_US.UTF-8
  run update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
  ok "Locale set"
else
  ok "Locale already en_US.UTF-8"
fi

###############################################################################
# Step 2 — apt packages
###############################################################################
log "Step 2: apt update + full-upgrade + packages"
run apt-get update -qq
run apt-get full-upgrade -yq
run apt-get install -yq --no-install-recommends \
  unattended-upgrades apt-listchanges \
  fail2ban ufw \
  curl git jq \
  age rclone \
  htop ca-certificates gnupg lsb-release \
  gettext-base
ok "Packages installed"

# Configure unattended-upgrades (security only, no auto-reboot)
# Must use .conf extension — apt ignores files with other extensions.
if [[ ! -f /etc/apt/apt.conf.d/52cherrio-unattended-upgrades.conf ]]; then
  run tee /etc/apt/apt.conf.d/52cherrio-unattended-upgrades.conf > /dev/null <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
EOF
  ok "unattended-upgrades policy written"
fi
# Enable periodic run (apt.conf.d files need 20auto-upgrades too)
if [[ ! -f /etc/apt/apt.conf.d/20auto-upgrades ]]; then
  run tee /etc/apt/apt.conf.d/20auto-upgrades > /dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  ok "20auto-upgrades written"
fi

###############################################################################
# Step 3 — Swap (4 GB), swappiness, overcommit
###############################################################################
log "Step 3: swap + kernel parameters"
if ! swapon --show | grep -q '/swapfile'; then
  if [[ ! -f /swapfile ]]; then
    run fallocate -l 4G /swapfile
    run chmod 600 /swapfile
    run mkswap /swapfile
  fi
  run swapon /swapfile
  ok "Swap activated"
else
  ok "Swap already active"
fi

if ! grep -q '/swapfile' /etc/fstab; then
  echo '/swapfile none swap sw 0 0' | run tee -a /etc/fstab > /dev/null
fi

run sysctl -w vm.swappiness=10 > /dev/null
run sysctl -w vm.overcommit_memory=1 > /dev/null
if ! grep -q 'vm.swappiness' /etc/sysctl.d/99-cherrio.conf 2>/dev/null; then
  run tee /etc/sysctl.d/99-cherrio.conf > /dev/null <<'EOF'
vm.swappiness=10
vm.overcommit_memory=1
EOF
fi
ok "Swap and kernel params set"

###############################################################################
# Step 4 — Docker Engine (official apt repo)
###############################################################################
log "Step 4: Docker Engine"
CODENAME="$(lsb_release -cs)"
log "Detected Ubuntu codename: ${CODENAME}"

DOCKER_REPO_URL="https://download.docker.com/linux/ubuntu/dists/${CODENAME}/"
HTTP_STATUS=$(curl -o /dev/null -s -w "%{http_code}" --max-time 10 "${DOCKER_REPO_URL}" || true)
if [[ "$HTTP_STATUS" != "200" ]]; then
  die "Docker's apt repo does not publish packages for Ubuntu codename '${CODENAME}' (HTTP ${HTTP_STATUS}). " \
      "Check https://docs.docker.com/engine/install/ubuntu/ and update this script when packages are available."
fi
ok "Docker repo supports codename '${CODENAME}'"

if ! command -v docker &>/dev/null; then
  run install -m 0755 -d /etc/apt/keyrings
  # Wrap the pipeline in bash -c so --dry-run echoes the whole thing
  # rather than running gpg for real while only echoing curl.
  run bash -c "curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg"
  run chmod a+r /etc/apt/keyrings/docker.gpg
  run tee /etc/apt/sources.list.d/docker.list > /dev/null <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu ${CODENAME} stable
EOF
  run apt-get update -qq
  run apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  ok "Docker installed"
else
  ok "Docker already installed ($(docker --version 2>/dev/null || true))"
fi

# Configure Docker daemon
if [[ ! -f /etc/docker/daemon.json ]] || ! grep -q 'json-file' /etc/docker/daemon.json; then
  run tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "live-restore": true
}
EOF
  run systemctl reload docker || run systemctl restart docker
  ok "Docker daemon configured"
fi

###############################################################################
# Step 5 — deploy user
###############################################################################
log "Step 5: deploy user"
if ! id deploy &>/dev/null; then
  run useradd -m -s /bin/bash -G docker deploy
  ok "User 'deploy' created"
else
  ok "User 'deploy' exists"
  run usermod -aG docker deploy
fi

# Copy root's authorized_keys
DEPLOY_SSH_DIR="/home/deploy/.ssh"
if [[ ! -f "${DEPLOY_SSH_DIR}/authorized_keys" ]]; then
  run mkdir -p "${DEPLOY_SSH_DIR}"
  run cp /root/.ssh/authorized_keys "${DEPLOY_SSH_DIR}/authorized_keys"
  run chown -R deploy:deploy "${DEPLOY_SSH_DIR}"
  run chmod 700 "${DEPLOY_SSH_DIR}"
  run chmod 600 "${DEPLOY_SSH_DIR}/authorized_keys"
  ok "Authorized keys copied to deploy"
fi

# Passwordless sudo
SUDOERS_FILE="/etc/sudoers.d/deploy"
if [[ ! -f "$SUDOERS_FILE" ]]; then
  echo 'deploy ALL=(ALL) NOPASSWD:ALL' | run tee "$SUDOERS_FILE" > /dev/null
  run chmod 0440 "$SUDOERS_FILE"
  ok "Passwordless sudo configured for deploy"
fi

###############################################################################
# Step 6 — UFW + fail2ban
###############################################################################
log "Step 6: UFW + fail2ban"
run ufw --force reset > /dev/null
run ufw default deny incoming
run ufw default allow outgoing
run ufw allow 22/tcp comment 'SSH'
run ufw allow 80/tcp comment 'HTTP'
run ufw allow 443/tcp comment 'HTTPS'
run ufw --force enable
ok "UFW configured"

if [[ ! -f /etc/fail2ban/jail.d/cherrio.conf ]]; then
  run tee /etc/fail2ban/jail.d/cherrio.conf > /dev/null <<'EOF'
[sshd]
enabled  = true
maxretry = 5
bantime  = 3600
findtime = 600
EOF
  run systemctl enable --now fail2ban
  run systemctl reload fail2ban || true
  ok "fail2ban sshd jail configured"
fi

###############################################################################
# Step 7 — Directories
###############################################################################
log "Step 7: /opt/cherrio directories"
for dir in /opt/cherrio/infra /opt/cherrio/backups /opt/cherrio/secrets; do
  run mkdir -p "$dir"
done
run chmod 700 /opt/cherrio/secrets
run chown -R deploy:deploy /opt/cherrio
ok "Directories ready"

###############################################################################
# Done
###############################################################################
log ""
log "=== Provisioning complete ==="
log ""
log "Next steps (in order):"
log "  1. From your local machine, verify: ssh deploy@49.13.63.71 'sudo -v'"
log "  2. Run: sudo bash infra/provision/harden-ssh.sh"
log "  3. Copy infra/shared/ to /opt/cherrio/infra/ on the server"
log "  4. Create /opt/cherrio/secrets/infra.env (see infra/shared/.env.example)"
log "  5. Run: cd /opt/cherrio/infra && docker compose up -d"
log "  6. Run: bash infra/shared/ensure-databases.sh /opt/cherrio/secrets/infra.env"
log "  7. Run: bash infra/backups/install-backups.sh"
log "  8. Set up Hetzner Cloud Firewall — see infra/README.md"
