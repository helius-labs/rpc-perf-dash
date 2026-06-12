#!/usr/bin/env bash
#
# deploy-all-workers.sh — redeploy every worker in the fleet from the
# current git HEAD. Covers:
#
#   - AWS (ECS Fargate): RpcBenchWorkerA / RpcBenchWorkerB in us-east-2,
#     eu-central-1, ap-northeast-1. Run per-region serially to avoid the
#     cdk-assets multi-region docker-tag race (see deploy-cf.sh notes).
#   - TeraSwitch (bare-metal systemd): ewr / ams / tokyo via deploy-tsw.sh.
#   - Cloudflare Containers: all 6 lanes via deploy-cf.sh.
#   - GCP (Cloud Run): all 6 regions via infra/gcp/build-image.sh +
#     terraform apply against infra/gcp/terraform. NOTE: this assumes the
#     one-time shared resources (Artifact Registry repo, Secret Manager
#     secrets, worker SA) are already applied — see infra/gcp/README.md for
#     the first-time rollout.
#
# The generator (RpcBenchGenerator in us-east-2) is NOT touched here — it's
# a separate stack and a separate deploy concern. Use:
#   cd infra/cdk && cdk deploy RpcBenchGenerator --profile "$AWS_PROFILE" --exclusively
#
# Flags (set to skip a tier):
#   SKIP_AWS=1     skip AWS workers
#   SKIP_TSW=1     skip TeraSwitch
#   SKIP_CF=1      skip Cloudflare
#   SKIP_GCP=1     skip GCP workers
#
# Examples:
#   ./deploy-all-workers.sh                  # everything
#   SKIP_CF=1 ./deploy-all-workers.sh        # everything except CF
#   SKIP_AWS=1 SKIP_TSW=1 SKIP_GCP=1 ./deploy-all-workers.sh   # CF only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"

SKIP_AWS="${SKIP_AWS:-0}"
SKIP_TSW="${SKIP_TSW:-0}"
SKIP_CF="${SKIP_CF:-0}"
SKIP_GCP="${SKIP_GCP:-0}"

# Per-tier region lists. AWS regions match infra/cdk/bin/app.ts WORKER_REGIONS.
AWS_REGIONS=(us-east-2 eu-central-1 ap-northeast-1)
AWS_PROFILE_NAME="${AWS_PROFILE:-dev}"

# TSW inventory lives in a gitignored file (server IPs stay out of git).
# infra/bare-metal/hosts.env must define a TSW_HOSTS bash array of
# "BOX_IP REGION EGRESS_PATH" triples, e.g.:
#   TSW_HOSTS=(
#     "198.51.100.10 ewr   tsw-ewr-1"
#     "198.51.100.20 ams   tsw-ams-1"
#   )
TSW_HOSTS=()
TSW_HOSTS_FILE="$INFRA_DIR/bare-metal/hosts.env"
if [[ -f "$TSW_HOSTS_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$TSW_HOSTS_FILE"
fi

SHARED_ENV="/tmp/rpc-bench-worker.env.shared"

log()   { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
step()  { printf '\033[1;35m[deploy %s]\033[0m %s\n' "$1" "$2"; }
fail()  { printf '\033[1;31m[deploy ERR]\033[0m %s\n' "$*" >&2; exit 1; }
warn()  { printf '\033[1;33m[deploy WARN]\033[0m %s\n' "$*" >&2; }

# ── Prechecks ────────────────────────────────────────────────────────────
log "git HEAD: $(git -C "$REPO_ROOT" rev-parse --short HEAD) ($(git -C "$REPO_ROOT" log -1 --pretty=%s))"

# Image tag for GCP + CF. Both build their docker context from the working
# tree, but tag by git SHA by default — so a DIRTY tree pushes new layers under
# the SAME tag, leaving terraform's `worker_image` var and the wrangler image
# ref unchanged → no new revision → old code keeps serving. To deploy
# uncommitted code without a commit, force a unique tag when the tree is dirty.
# (AWS cdk `fromAsset` content-hashes the context and TSW rsyncs, so both pick
# up the working tree regardless — they don't use this tag.)
# Honor a caller-provided DEPLOY_TAG override.
if [[ -z "${DEPLOY_TAG:-}" ]]; then
  if git -C "$REPO_ROOT" diff-index --quiet HEAD --; then
    DEPLOY_TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  else
    DEPLOY_TAG="dirty-$(date -u +%Y%m%d-%H%M%S)"
  fi
fi
export DEPLOY_TAG

if ! git -C "$REPO_ROOT" diff-index --quiet HEAD --; then
  warn "working tree has uncommitted changes — they WILL be deployed everywhere:"
  warn "  TSW (rsync) + CF/GCP (docker build from working tree, forced tag '$DEPLOY_TAG') + AWS (cdk fromAsset content-hash)."
  warn "press ctrl-c to abort, or wait 5s to continue."
  sleep 5
fi

if [[ "$SKIP_AWS" != "1" ]]; then
  command -v aws >/dev/null   || fail "aws cli missing"
  command -v cdk >/dev/null   || fail "cdk cli missing"
  command -v docker >/dev/null || fail "docker missing"
  aws sts get-caller-identity --profile "$AWS_PROFILE_NAME" >/dev/null 2>&1 \
    || fail "AWS session expired — run 'aws sso login --profile $AWS_PROFILE_NAME' and retry."
fi

if [[ "$SKIP_TSW" != "1" || "$SKIP_CF" != "1" ]]; then
  [[ -f "$SHARED_ENV" ]] || fail "$SHARED_ENV missing — TSW and CF need it. Build it first."
fi

if [[ "$SKIP_TSW" != "1" && ${#TSW_HOSTS[@]} -eq 0 ]]; then
  fail "no TSW inventory — create $TSW_HOSTS_FILE (see comment above TSW_HOSTS) or set SKIP_TSW=1."
fi

if [[ "$SKIP_CF" != "1" ]]; then
  command -v wrangler >/dev/null || fail "wrangler missing"
fi

if [[ "$SKIP_GCP" != "1" ]]; then
  command -v gcloud >/dev/null    || fail "gcloud cli missing"
  command -v terraform >/dev/null || fail "terraform missing"
  command -v docker >/dev/null    || fail "docker missing"
  [[ -n "${PROJECT_ID:-}" ]] || fail "PROJECT_ID not set — export your GCP project id (or SKIP_GCP=1)."
  gcloud auth print-access-token >/dev/null 2>&1 \
    || fail "gcloud auth expired — run 'gcloud auth login' and retry."
fi

# ── AWS workers (serial per region) ──────────────────────────────────────
if [[ "$SKIP_AWS" != "1" ]]; then
  for region in "${AWS_REGIONS[@]}"; do
    step "aws/$region" "cdk deploy RpcBenchWorkerA + RpcBenchWorkerB"
    (
      cd "$INFRA_DIR/cdk"
      cdk deploy \
        "RpcBenchWorkerA-$region" \
        "RpcBenchWorkerB-$region" \
        --profile "$AWS_PROFILE_NAME" \
        --exclusively \
        --require-approval never \
        --concurrency 1
    ) || fail "cdk deploy failed for $region"
  done
  log "AWS done."
fi

# ── TeraSwitch (serial — each ssh+rsync should finish before next box) ───
if [[ "$SKIP_TSW" != "1" ]]; then
  for host in "${TSW_HOSTS[@]}"; do
    # shellcheck disable=SC2086
    read -r box region egress _rest <<<"$host"
    step "tsw/$region" "deploy-tsw.sh $box $region $egress"
    bash "$INFRA_DIR/bare-metal/deploy-tsw.sh" "$box" "$region" "$egress" \
      || fail "deploy-tsw.sh failed for $region ($box)"
  done
  log "TSW done."
fi

# ── Cloudflare Containers ────────────────────────────────────────────────
if [[ "$SKIP_CF" != "1" ]]; then
  step "cf" "deploy-cf.sh (builds image, pushes to CF registry, rolls 6 lanes) [tag $DEPLOY_TAG]"
  TAG="$DEPLOY_TAG" bash "$INFRA_DIR/cloudflare/deploy-cf.sh" \
    || fail "deploy-cf.sh failed"
  log "CF done."
fi

# ── GCP Cloud Run (build image, then terraform apply to all 6 regions) ───
# Assumes the one-time shared resources already exist. If this is a fresh
# project, run the targeted apply from infra/gcp/README.md first.
if [[ "$SKIP_GCP" != "1" ]]; then
  step "gcp" "build-image.sh (push worker image to Artifact Registry) [tag $DEPLOY_TAG]"
  GCP_IMAGE_URI="$(bash "$INFRA_DIR/gcp/build-image.sh" "$DEPLOY_TAG")"
  [[ -n "$GCP_IMAGE_URI" ]] || fail "build-image.sh returned an empty URI"

  # Terraform's google provider needs credentials. Application Default
  # Credentials (gcloud auth application-default login) are blocked by org
  # policy here, so mint a short-lived token from the existing 'gcloud auth
  # login' user session and hand it to the provider via GOOGLE_OAUTH_ACCESS_TOKEN
  # (its `access_token` source). Respect a caller-provided token if already set.
  if [[ -z "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]]; then
    GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token 2>/dev/null)" \
      || fail "GCP: could not mint an access token — run 'gcloud auth login' (ADC not required)"
    export GOOGLE_OAUTH_ACCESS_TOKEN
  fi

  step "gcp" "terraform apply (6 regions: us-east4 us-west1 europe-west3 europe-west2 asia-northeast1 asia-southeast1)"
  (
    cd "$INFRA_DIR/gcp/terraform"
    terraform init -input=false >/dev/null
    terraform apply \
      -input=false \
      -auto-approve \
      -var="project_id=$PROJECT_ID" \
      -var="worker_image=$GCP_IMAGE_URI"
  ) || fail "terraform apply failed for GCP"
  log "GCP done."
fi

log "ALL DONE."
log "Run the verifier to confirm fleet health:"
log "  pnpm --filter @rpcbench/db exec tsx ../../infra/scripts/verify-deploy.ts"
