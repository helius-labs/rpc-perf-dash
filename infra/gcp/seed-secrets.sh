#!/usr/bin/env bash
#
# seed-secrets.sh — push worker secrets into GCP Secret Manager.
#
# Reads a local env file (key=value lines), creates the secret if missing,
# and adds a new version with the value. Skips keys that aren't in the
# expected worker set so it can be pointed at an over-broad .env without
# polluting Secret Manager.
#
# Usage:
#   ./seed-secrets.sh <ENV_FILE>
#
# Example:
#   ./seed-secrets.sh /tmp/rpc-bench-worker.env.shared
#
# Prereqs:
#   - terraform apply has been run once (creates the Secret Manager secrets
#     with auto-replication and the worker IAM binding).
#   - gcloud auth login + gcloud config set project <your-project-id>.
#   - PROJECT_ID exported (your GCP project id).
#
# Idempotent: each run adds a NEW version; old versions stay until garbage-
# collected manually. Cloud Run env vars use version=latest, so a fresh seed
# takes effect on the next service revision.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <ENV_FILE>" >&2
  exit 2
fi

ENV_FILE="$1"
[[ -f "$ENV_FILE" ]] || { echo "[seed-secrets] missing: $ENV_FILE" >&2; exit 1; }

PROJECT_ID="${PROJECT_ID:?PROJECT_ID not set — export your GCP project id}"

# Single source of truth: WORKER_SECRET_KEYS in packages/shared/src/env-keys.ts
# (derived from the provider registry). This literal list can't import it, so
# packages/shared/src/env-keys.test.ts asserts they match — CI fails on drift.
# Workers open a pooled connection only, so the direct (unpooled) Neon URL is
# not seeded here. Kept as a filter so this script can be pointed at an
# over-broad env file without pushing non-worker keys into Secret Manager.
WORKER_SECRETS=(
  NEON_DATABASE_URL_POOLED
  HELIUS_URL
  TRITON_URL
  ALCHEMY_URL
  QUICKNODE_URL
  CHAINSTACK_URL
)

is_worker_secret() {
  local k="$1"
  for w in "${WORKER_SECRETS[@]}"; do
    [[ "$k" == "$w" ]] && return 0
  done
  return 1
}

seen_count=0
skipped_count=0
pushed=()

while IFS= read -r line || [[ -n "$line" ]]; do
  # Strip comments and blank lines.
  [[ -z "${line// }" ]] && continue
  [[ "$line" =~ ^# ]] && continue

  # Split on first =; preserve everything after.
  key="${line%%=*}"
  value="${line#*=}"
  key="$(echo "$key" | tr -d '[:space:]')"

  # Strip surrounding quotes if present.
  if [[ "$value" =~ ^\".*\"$ ]]; then
    value="${value:1:${#value}-2}"
  fi

  if ! is_worker_secret "$key"; then
    skipped_count=$((skipped_count + 1))
    continue
  fi

  seen_count=$((seen_count + 1))
  echo "[seed-secrets] pushing $key"
  # add-version reads value from stdin; --data-file=- avoids it landing in argv.
  printf '%s' "$value" | gcloud secrets versions add "$key" \
    --project="$PROJECT_ID" \
    --data-file=- \
    >/dev/null
  pushed+=("$key")
done < "$ENV_FILE"

echo
echo "[seed-secrets] pushed:  ${#pushed[@]} (${pushed[*]:-none})"
echo "[seed-secrets] skipped: $skipped_count keys not in worker secret set"

# Warn if any expected secret was missing from the env file.
for w in "${WORKER_SECRETS[@]}"; do
  found=0
  for p in "${pushed[@]:-}"; do
    [[ "$p" == "$w" ]] && { found=1; break; }
  done
  if [[ $found -eq 0 ]]; then
    echo "[seed-secrets] WARN: $w was not in $ENV_FILE — Cloud Run will fail to start until you add a version manually." >&2
  fi
done
