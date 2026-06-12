#!/usr/bin/env bash
#
# build-image.sh — build the rpc-perf-dash worker image and push it to GCP
# Artifact Registry. Prints the full image URI on success — pass that into
# terraform as -var=worker_image=<uri>.
#
# Usage:
#   ./build-image.sh [TAG]
#
# Defaults:
#   TAG = current git short SHA
#
# Prereqs:
#   - PROJECT_ID exported (your GCP project id).
#   - gcloud auth configure-docker us-central1-docker.pkg.dev   (once per machine)
#   - The project has the Artifact Registry repo `rpc-bench`
#     (created by `terraform apply` on first run; if you're building before
#     the first apply, create it manually first via gcloud).
#
# Idempotent: re-running rebuilds and pushes; the digest changes only if
# the source changed.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?PROJECT_ID not set — export your GCP project id}"
LOCATION="${LOCATION:-us-central1}"
REPO="${REPO:-rpc-bench}"
IMAGE="${IMAGE:-worker}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TAG="${1:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"
URI="${LOCATION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}"

# Logs go to stderr so callers can capture the URI on stdout (the
# deploy-all-workers.sh orchestrator relies on this).
log() { printf '[build-image] %s\n' "$*" >&2; }

log "repo root: $REPO_ROOT"
log "target:    $URI"

# linux/amd64 forced — Cloud Run runs x86_64. Building on Apple Silicon
# without --platform produces an arm64 image Cloud Run can't schedule.
docker buildx build \
  --platform linux/amd64 \
  -f "$REPO_ROOT/apps/worker/Dockerfile" \
  -t "$URI" \
  --push \
  "$REPO_ROOT" >&2

log "pushed: $URI"

# Stdout: just the URI, so callers can $(./build-image.sh) it.
echo "$URI"
