#!/usr/bin/env bash
#
# preflight.sh — shared cloud-auth probes. SOURCE this file, don't execute it.
#
# Each check_* runs a read-only "am I logged in?" probe and returns 0 (reachable)
# or non-zero (not reachable / not authed). The matching hint_* prints the fix
# command. Keeping the probe and the hint separate lets each caller choose its
# own policy: deploy-all-workers.sh treats a failed probe as fatal (`|| fail`),
# while bootstrap.sh treats it as "skip this cloud" (mark it `-`, not `✗`).
#
# These are the only three "am I authed" idioms in the repo; centralize them
# here so the probe command + hint text live in one place.

# check_aws <profile> — AWS SSO / STS reachability for the given profile.
check_aws() {
  local profile="${1:-}"
  [[ -n "$profile" ]] || return 1
  aws sts get-caller-identity --profile "$profile" >/dev/null 2>&1
}
hint_aws() {
  local profile="${1:-\$AWS_PROFILE}"
  echo "AWS: run 'aws sso login --profile ${profile}' (or set AWS_PROFILE to a profile for your account)."
}

# check_gcp — gcloud can mint an access token (the terraform google provider needs it).
check_gcp() {
  gcloud auth print-access-token >/dev/null 2>&1
}
hint_gcp() {
  echo "GCP: run 'gcloud auth login'."
}

# check_cf — wrangler is logged in. Modeled on the informational probe in deploy-cf.sh.
check_cf() {
  wrangler whoami >/dev/null 2>&1
}
hint_cf() {
  echo "Cloudflare: run 'wrangler login' (needs Containers:Edit scope on the 'Helius - Dev' account)."
}
