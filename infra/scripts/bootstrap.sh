#!/usr/bin/env bash
#
# bootstrap.sh — one-command deployment-credentials setup. Works whether or not
# you have Helius AWS access; the AWS pull is opportunistic, not required.
#
#   pnpm bootstrap:creds
#
# With AWS access (operator):  aws sso login --profile "$AWS_PROFILE" first, then
#   this pulls .env (app secrets from rpcbench/env), .ops.env + hosts.env (deploy
#   config from rpcbench/ops), and you're provisioned for all four clouds.
#
# Without AWS access (external contributor / grant pending): it detects AWS is
#   unreachable, copies .env.example -> .env for you to fill in, and marks the
#   AWS/ops/TSW steps SKIPPED (not failed). Both paths still run build:shared-env
#   and print a checklist.
#
# The script is generic: the only identifiers it references are the already-public
# secret ids (rpcbench/env, rpcbench/ops) and the default region. Account-specific
# values live only in AWS and the gitignored local files it writes.

set -uo pipefail   # NOT -e: a failed cloud probe is "skip", not "abort".

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=lib/preflight.sh
source "$SCRIPT_DIR/lib/preflight.sh"

ENV_SECRET_ID="rpcbench/env"
OPS_SECRET_ID="rpcbench/ops"
REGION="${AWS_REGION:-us-east-2}"
HOSTS_FILE="$INFRA_DIR/bare-metal/hosts.env"

OK="✓"; NO="✗"; SKIP="-"
RESULTS=()   # "mark|label|detail"
record() { RESULTS+=("$1|$2|${3:-}"); }

log()  { printf '\033[1;36m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bootstrap WARN]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[bootstrap ERR]\033[0m %s\n' "$*" >&2; exit 1; }

aws_get_secret() {  # aws_get_secret <secret-id>  -> SecretString on stdout
  local args=(secretsmanager get-secret-value --secret-id "$1"
              --region "$REGION" --query SecretString --output text)
  [[ -n "${AWS_PROFILE:-}" ]] && args+=(--profile "$AWS_PROFILE")
  aws "${args[@]}"
}

# ── 1. Tooling check (advisory) ──────────────────────────────────────────────
log "checking tools on PATH…"
for tool in aws gcloud wrangler docker cdk terraform jq pnpm; do
  if command -v "$tool" >/dev/null 2>&1; then
    record "$OK" "tool: $tool"
  else
    record "$SKIP" "tool: $tool" "not installed — needed for the matching cloud/deploy step"
  fi
done

# ── 2. AWS branch (not a gate) ───────────────────────────────────────────────
AWS_OK=0
if command -v aws >/dev/null 2>&1 && check_aws "${AWS_PROFILE:-}"; then
  AWS_OK=1
  record "$OK" "AWS auth" "profile '${AWS_PROFILE}' reachable"
else
  record "$SKIP" "AWS auth" "$(hint_aws "${AWS_PROFILE:-}")"
fi

if [[ "$AWS_OK" == "1" ]]; then
  command -v jq >/dev/null 2>&1 || fail "jq is required to pull secrets — install jq and retry."

  # ── 3. Pull app secrets: rpcbench/env -> .env ──────────────────────────────
  log "pulling app secrets from $ENV_SECRET_ID -> .env"
  if env_json="$(aws_get_secret "$ENV_SECRET_ID")"; then
    printf '%s' "$env_json" | jq -r 'to_entries[] | "\(.key)=\(.value)"' > .env
    chmod 600 .env
    record "$OK" ".env (app secrets)" "$(jq -r 'keys | length' <<<"$env_json") key(s) written from $ENV_SECRET_ID"
    if [[ -f .env.local ]]; then
      warn ".env.local exists and SHADOWS the freshly-pulled .env (precedence: real env > .env.local > .env)."
      record "$SKIP" ".env.local shadow" "an existing .env.local overrides pulled values — reconcile if stale"
    fi
  else
    record "$NO" ".env (app secrets)" "could not read $ENV_SECRET_ID despite AWS auth — check IAM on the secret"
  fi

  # ── 4. Pull deploy config: rpcbench/ops -> .ops.env + hosts.env ────────────
  log "pulling deploy config from $OPS_SECRET_ID -> .ops.env + hosts.env"
  if ops_json="$(aws_get_secret "$OPS_SECRET_ID")"; then
    # Scalars (everything except TSW_HOSTS) -> .ops.env
    printf '%s' "$ops_json" \
      | jq -r 'to_entries[] | select(.key != "TSW_HOSTS") | "\(.key)=\(.value)"' > .ops.env
    chmod 600 .ops.env
    record "$OK" ".ops.env (deploy config)" "CF/GCP ids written from $OPS_SECRET_ID"

    # TSW_HOSTS (a JSON-string array) -> bash-array hosts.env (round-trip contract)
    tsw="$(printf '%s' "$ops_json" | jq -r '.TSW_HOSTS // empty')"
    if [[ -n "$tsw" ]]; then
      {
        echo "TSW_HOSTS=("
        printf '%s' "$tsw" | jq -r '.[] | "  \"\(.)\""'
        echo ")"
      } > "$HOSTS_FILE"
      chmod 600 "$HOSTS_FILE"
      record "$OK" "hosts.env (TSW inventory)" "$(printf '%s' "$tsw" | jq -r 'length') box(es)"
    else
      record "$SKIP" "hosts.env (TSW inventory)" "no TSW_HOSTS in $OPS_SECRET_ID"
    fi
  else
    record "$SKIP" ".ops.env / hosts.env" "could not read $OPS_SECRET_ID (not seeded yet?) — seed with 'pnpm seed:ops'"
  fi
else
  # ── Fallback path (no AWS): seed .env from the template ─────────────────────
  if [[ -f .env ]]; then
    record "$SKIP" ".env" "already present — left untouched (no AWS pull)"
  elif [[ -f .env.example ]]; then
    cp .env.example .env
    record "$SKIP" ".env" "copied from .env.example — fill in NEON_*, provider URLs, UTILITY_RPC_URL, GENERATOR_SECRET"
    warn "no AWS reachable: filled .env from .env.example. Fill in your values, then re-run."
  else
    fail ".env.example not found — cannot seed a starter .env."
  fi
  record "$SKIP" ".ops.env / hosts.env" "AWS-only (deploy config lives in rpcbench/ops)"
fi

# ── 5. Build shared env (both paths, from local .env) ────────────────────────
log "building /tmp/rpc-bench-worker.env.shared from local .env"
if pnpm build:shared-env >/dev/null 2>&1; then
  record "$OK" "shared worker env" "/tmp/rpc-bench-worker.env.shared built"
else
  record "$NO" "shared worker env" "build:shared-env failed — fill provider/DB vars in .env, then re-run"
fi

# ── 6. GCP / CF probes (skipped, not failed, without access) ──────────────────
if command -v gcloud >/dev/null 2>&1 && check_gcp; then
  record "$OK" "GCP auth" "gcloud can mint an access token"
else
  record "$SKIP" "GCP auth" "$(hint_gcp)"
fi
if command -v wrangler >/dev/null 2>&1 && check_cf; then
  record "$OK" "Cloudflare auth" "wrangler logged in"
else
  record "$SKIP" "Cloudflare auth" "$(hint_cf)"
fi

# ── 7. TSW reachability (AWS path only; needs the inventory) ──────────────────
if [[ "$AWS_OK" == "1" && -f "$HOSTS_FILE" ]]; then
  # shellcheck source=/dev/null
  TSW_HOSTS=(); source "$HOSTS_FILE"
  if [[ ${#TSW_HOSTS[@]} -gt 0 ]]; then
    reach=0; total=0
    for host in "${TSW_HOSTS[@]}"; do
      read -r box _region _egress _rest <<<"$host"
      total=$((total + 1))
      if ssh -o BatchMode=yes -o ConnectTimeout=5 "ubuntu@$box" 'echo ok' >/dev/null 2>&1; then
        reach=$((reach + 1))
      fi
    done
    if [[ "$reach" == "$total" ]]; then
      record "$OK" "TSW reachability" "$reach/$total boxes reachable over SSH"
    else
      record "$NO" "TSW reachability" "$reach/$total reachable — add your SSH pubkey to the unreachable boxes' authorized_keys"
    fi
  else
    record "$SKIP" "TSW reachability" "hosts.env has no boxes"
  fi
else
  record "$SKIP" "TSW reachability" "no inventory (AWS-only)"
fi

# ── 8. Summary ───────────────────────────────────────────────────────────────
echo
echo "Bootstrap summary   (✓ done · ✗ needs fixing · - skipped/no access)"
echo "======================================================================"
had_fail=0
for r in "${RESULTS[@]}"; do
  IFS='|' read -r mark label detail <<<"$r"
  printf '  %s  %s\n' "$mark" "$label"
  [[ -n "$detail" ]] && printf '        %s\n' "$detail"
  [[ "$mark" == "$NO" ]] && had_fail=1
done
echo "======================================================================"

echo
if [[ "$AWS_OK" == "1" ]]; then
  echo "Next: bring up the DB/app, then deploy —"
  echo "  pnpm bootstrap                                   # DB preflight + migrate + honeypots"
  echo "  (cd infra/cdk && cdk deploy RpcBenchGenerator --profile \"\$AWS_PROFILE\" --exclusively)"
  echo "  bash infra/scripts/deploy-all-workers.sh          # all four worker fleets"
else
  echo "Next: fill in .env (provider keys + DB URLs), then either —"
  echo "  pnpm benchmark        # standalone CLI, no DB needed"
  echo "  pnpm bootstrap        # full local system (needs a Postgres URL)"
  echo "Or, if you use AWS Secrets Manager: 'aws sso login --profile \"\$AWS_PROFILE\"' then re-run 'pnpm bootstrap:creds'."
fi

# Exit non-zero only on a genuine failure (✗), never merely for skipped clouds.
exit "$had_fail"
