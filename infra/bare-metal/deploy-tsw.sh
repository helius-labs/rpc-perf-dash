#!/usr/bin/env bash
#
# deploy-tsw.sh — end-to-end deploy of the rpc-perf-dash worker to one
# TeraSwitch bare-metal box.
#
# Usage:
#   ./deploy-tsw.sh <BOX_IP> <REGION> <EGRESS_PATH> [SSH_USER]
#
# Examples (placeholder IPs — use your own box inventory):
#   ./deploy-tsw.sh 198.51.100.10 ewr    tsw-ewr-1
#   ./deploy-tsw.sh 198.51.100.20 ams    tsw-ams-1
#   ./deploy-tsw.sh 198.51.100.30 tokyo  tsw-tokyo-1
#
# Prerequisites:
#   - /tmp/rpc-bench-worker.env.shared exists locally: a KEY=VAL file with
#     the worker's shared secrets (NEON_DATABASE_URL_*, provider URL/key
#     vars, GENERATOR_SECRET) — the worker-relevant subset of .env.example.
#   - SSH key access to the box as the SSH_USER (default: ubuntu).
#   - Migration 0007 already applied to the database.
#
# Idempotent: re-running re-syncs source and restarts the service.

set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <BOX_IP> <REGION> <EGRESS_PATH> [SSH_USER]"
  exit 2
fi

BOX="$1"
REGION="$2"
EGRESS="$3"
SSH_USER="${4:-ubuntu}"

SHARED_ENV="/tmp/rpc-bench-worker.env.shared"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_REPO="/opt/rpc-perf-dash"
REMOTE_ENV="/etc/rpc-bench-worker.env"
REMOTE_UNIT="/etc/systemd/system/rpc-bench-worker.service"

log()  { printf '\033[1;36m[%s]\033[0m %s\n' "$REGION" "$*"; }
fail() { printf '\033[1;31m[%s ERR]\033[0m %s\n' "$REGION" "$*" >&2; exit 1; }

# ── Prechecks ────────────────────────────────────────────────────────────
[[ -f "$SHARED_ENV" ]] || fail "$SHARED_ENV missing — build it first (see the Prerequisites comment at the top of this script)."
[[ -d "$REPO_ROOT/apps/worker" ]] || fail "repo root not found at $REPO_ROOT"

log "preflight: testing SSH to $SSH_USER@$BOX ..."
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$SSH_USER@$BOX" 'echo ok' >/dev/null; then
  fail "ssh failed. Confirm key access to $SSH_USER@$BOX."
fi

# ── Step 4: per-box env ──────────────────────────────────────────────────
log "step 4: composing + uploading /etc/rpc-bench-worker.env"

BOX_ENV="$(mktemp)"
trap 'rm -f "$BOX_ENV"' EXIT
{
  echo "WORKER_PROVIDER=teraswitch"
  echo "WORKER_REGION=$REGION"
  echo "WORKER_EGRESS_PATH=$EGRESS"
  cat "$SHARED_ENV"
} > "$BOX_ENV"
chmod 600 "$BOX_ENV"

scp -q "$BOX_ENV" "$SSH_USER@$BOX:/tmp/box.env"
ssh "$SSH_USER@$BOX" "sudo install -o root -g root -m 600 /tmp/box.env $REMOTE_ENV && rm /tmp/box.env"
log "step 4: env installed."

# ── Step 5: rsync repo + install runtime ─────────────────────────────────
log "step 5: rsync repo + Node 24 + pnpm deps (may take ~30-60s first time)"

ssh "$SSH_USER@$BOX" "sudo mkdir -p $REMOTE_REPO && sudo chown $SSH_USER:$SSH_USER $REMOTE_REPO"

rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .vercel \
  --exclude '.env*' --exclude '.git' --exclude '*.log' \
  --exclude '.claude' --exclude '.DS_Store' \
  --exclude 'cdk.out' --exclude 'dist' --exclude 'tsconfig.tsbuildinfo' \
  "$REPO_ROOT/" "$SSH_USER@$BOX:$REMOTE_REPO/"

ssh "$SSH_USER@$BOX" 'bash -s' <<'REMOTE'
set -euo pipefail

if ! command -v node >/dev/null 2>&1 || ! node -v 2>/dev/null | grep -qE '^v24'; then
  echo "[remote] installing Node 24 via nodesource"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable
echo "[remote] node=$(node -v) pnpm=$(pnpm -v) at $(which pnpm)"

cd /opt/rpc-perf-dash
pnpm install --frozen-lockfile --filter worker...
echo "[remote] pnpm install done"
REMOTE

log "step 5: deps installed."

# ── Step 6: systemd unit + (re)start ─────────────────────────────────────
log "step 6: installing systemd unit and starting service"

ssh "$SSH_USER@$BOX" "sudo bash -s" <<REMOTE
set -euo pipefail
PNPM_BIN="\$(command -v pnpm)"
[ -n "\$PNPM_BIN" ] || { echo 'pnpm not on PATH'; exit 1; }

cat > "$REMOTE_UNIT" <<UNIT
[Unit]
Description=rpc-perf-dash worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SSH_USER
WorkingDirectory=$REMOTE_REPO/apps/worker
EnvironmentFile=$REMOTE_ENV
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=\$PNPM_BIN start
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable rpc-bench-worker >/dev/null 2>&1 || true
systemctl restart rpc-bench-worker
sleep 4
echo "── recent log lines ──"
journalctl -u rpc-bench-worker --since='15 seconds ago' --no-pager | tail -30 || true

# Pass/fail by looking for the start line.
if journalctl -u rpc-bench-worker --since='30 seconds ago' --no-pager | \
     grep -qE 'provider=teraswitch region=$REGION'; then
  echo "[remote] OK: worker started for region=$REGION"
else
  echo "[remote] WARN: did not see expected start line — inspect 'journalctl -u rpc-bench-worker -n 100' on the box"
  exit 3
fi
REMOTE

log "DONE. Worker live at $BOX (region=$REGION egress=$EGRESS)."
