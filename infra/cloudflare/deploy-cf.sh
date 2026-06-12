#!/usr/bin/env bash
#
# deploy-cf.sh — end-to-end deploy of the rpc-perf-dash worker to Cloudflare
# Containers.
#
# What it does:
#   1. Builds the worker Docker image from the repo root (so the Dockerfile's
#      COPY pnpm-lock.yaml resolves correctly).
#   2. Tags + pushes the image to Cloudflare's managed registry.
#   3. Provisions secrets (DB URLs, RPC keys) from the shared env file.
#   4. Deploys the Worker with the container binding.
#
# Idempotent. Re-running rebuilds, re-pushes, and re-deploys.
#
# Prerequisites:
#   - CLOUDFLARE_ACCOUNT_ID exported (your Cloudflare account id) and
#     wrangler logged in to that account with the Containers scope.
#   - Docker running locally (for buildx).
#   - /tmp/rpc-bench-worker.env.shared exists locally: a KEY=VAL file with
#     the worker's shared secrets (NEON_DATABASE_URL_*, provider URL/key
#     vars, GENERATOR_SECRET) — i.e. the worker-relevant subset of
#     .env.example. Build it once from your .env and reuse it for the
#     TSW + CF deploys.

set -euo pipefail

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID not set — export your Cloudflare account id}"
IMAGE_NAME="rpc-bench-worker-cf"
# CF Containers refuses :latest (mutable). Use git SHA — falls back to a
# timestamp when not in a git repo. TAG env override forces a unique tag
# (needed when redeploying with uncommitted changes: the SHA is unchanged so
# wrangler sees "no changes" and skips the container instance recycle, which
# means new secrets / new code don't reach running containers. Override with
# `TAG=$(date +%s) bash deploy-cf.sh` to force a rollover.)
TAG="${TAG:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d-%H%M%S)}"
FULL_IMAGE="registry.cloudflare.com/${ACCOUNT_ID}/${IMAGE_NAME}:${TAG}"

CF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CF_DIR/../.." && pwd)"
SHARED_ENV="/tmp/rpc-bench-worker.env.shared"

log()  { printf '\033[1;36m[cf]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[cf ERR]\033[0m %s\n' "$*" >&2; exit 1; }

# ── Prechecks ────────────────────────────────────────────────────────────
[[ -f "$SHARED_ENV" ]] || fail "$SHARED_ENV missing — build it first (see TSW deploy notes)."
command -v docker  >/dev/null || fail "docker not found on PATH"
command -v wrangler >/dev/null || fail "wrangler not found on PATH"

export CLOUDFLARE_ACCOUNT_ID

log "wrangler whoami:"
wrangler whoami | grep -E 'Account ID|email' || true

# ── Step 1: build image from repo root ──────────────────────────────────
# --provenance=false --sbom=false: disable the SLSA attestation manifest
# that buildx adds by default. Without these flags the push produces an
# OCI image index with two manifests (the real linux/amd64 image plus an
# attestation with platform "unknown/unknown"), and CF Containers'
# firecracker pipeline can't resolve the right one — silently failing the
# container start with no error in health.errors and no stdout in tail.
# Verified via `docker buildx imagetools inspect`.
log "building $IMAGE_NAME from $REPO_ROOT/apps/worker/Dockerfile"
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  -t "$IMAGE_NAME:$TAG" \
  -t "$FULL_IMAGE" \
  -f "$REPO_ROOT/apps/worker/Dockerfile" \
  --load \
  "$REPO_ROOT"
log "build complete."

# ── Step 2: push to CF managed registry ─────────────────────────────────
log "pushing $IMAGE_NAME to Cloudflare managed registry"
wrangler containers push "$IMAGE_NAME:$TAG"
log "push complete: $FULL_IMAGE"

# ── Step 3: provision secrets ────────────────────────────────────────────
# Read SHARED_ENV line-by-line. Skip blank lines and comments. Each KEY=VAL
# becomes `wrangler secret put KEY` with stdin = VAL.
log "provisioning secrets from $SHARED_ENV"
cd "$CF_DIR"
while IFS='=' read -r key val; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  # Skip the per-vantage identity vars (those live in wrangler.jsonc as plain
  # vars, not secrets, since they're not sensitive).
  case "$key" in
    WORKER_PROVIDER|WORKER_REGION|WORKER_EGRESS_PATH|PORT) continue ;;
  esac
  # Strip surrounding double-quotes — Vercel-style .env files quote URL
  # values (NEON_DATABASE_URL_POOLED="postgresql://..."), and `cut -d= -f2-`
  # preserves those literal characters. Without stripping, the container
  # sees a URL with quote marks around it and crashes on URL parse.
  # Discovered the hard way: cost ~3 hours of CF debugging before boot.cjs's
  # recent_output buffer finally surfaced the actual exception.
  if [[ "$val" == \"*\" ]]; then
    val="${val:1:${#val}-2}"
  fi
  log "  $key"
  echo -n "$val" | wrangler secret put "$key" >/dev/null 2>&1 || \
    echo -n "$val" | wrangler secret put "$key"
done < "$SHARED_ENV"
log "secrets done."

# ── Step 4: substitute account + image SHA into a temp wrangler config ──
# wrangler.jsonc has __ACCOUNT_ID__ / __IMAGE_TAG__ placeholders so the
# committed file stays clean (no account-specific values, no churn per
# deploy). We write the substituted version to a temp file and point
# `wrangler deploy --config` at it. CF Containers requires immutable tags
# (no :latest), hence the git SHA.
log "substituting __ACCOUNT_ID__/__IMAGE_TAG__ into temp wrangler config"
# Temp config goes BESIDE the real wrangler.jsonc — wrangler resolves the
# `main: src/index.ts` path relative to the config file's directory, so a
# /tmp/ path would make it look for /tmp/src/index.ts. The dot-prefix
# keeps the file hidden and matches .gitignore.
WRANGLER_TMP="$CF_DIR/.wrangler-deploy-$$.jsonc"
# shellcheck disable=SC2064
trap "rm -f $WRANGLER_TMP" EXIT
sed -e "s/__IMAGE_TAG__/$TAG/g" -e "s/__ACCOUNT_ID__/$ACCOUNT_ID/g" \
  "$CF_DIR/wrangler.jsonc" > "$WRANGLER_TMP"

# ── Step 5: deploy ──────────────────────────────────────────────────────
# --cwd pins path resolution to $CF_DIR so the config's relative paths
# (`main: src/index.ts`) resolve correctly regardless of where this script
# is invoked from.
log "deploying Worker + container binding"
wrangler deploy --config "$WRANGLER_TMP" --cwd "$CF_DIR"

log "DONE."
log "next: wrangler tail rpc-bench-worker-cf  # stream logs"
log "      curl https://rpc-bench-worker-cf.<your-subdomain>.workers.dev/  # probe healthcheck"
log "      SELECT * FROM worker_heartbeat WHERE worker_provider='cloudflare';  # confirm registry pickup"
