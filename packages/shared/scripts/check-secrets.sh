#!/usr/bin/env bash
# check-secrets.sh — pre-commit + CI guard against committing API keys and
# operator-internal infrastructure identifiers.
#
# Greps the working tree for likely secret patterns. Allowlists .env.example,
# docs, and the Next.js lib (which receives env vars at runtime, not literals).
#
# Exit code 0 if clean, 1 if a likely secret is found.

set -euo pipefail

PATTERNS=(
  'sk-[A-Za-z0-9]{20,}'                # OpenAI / generic
  'AKIA[0-9A-Z]{16}'                   # AWS access key id
  'jup_[A-Za-z0-9]{40,}'               # Jupiter
  'helius_[A-Za-z0-9]{32,}'            # Helius (heuristic)
  '[A-Za-z0-9]{8}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{12}\?key=' # url-embedded key
)

# Operator-internal infrastructure identifiers (account ids, project ids,
# server IPs). The repo is public, so the identifier VALUES can't live in this
# script either — operators list them in a gitignored sibling file, one
# extended-regex pattern per line (comments/#-lines skipped):
#   packages/shared/scripts/check-secrets.local
LOCAL_PATTERNS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-secrets.local"
if [[ -f "$LOCAL_PATTERNS" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line// }" || "$line" =~ ^# ]] && continue
    PATTERNS+=("$line")
  done < "$LOCAL_PATTERNS"
fi

EXCLUDE=(
  ':!.env.example'
  ':!.env'
  # Scan docs/ (real docs shouldn't carry account ids); only skip working
  # drafts, which are gitignored anyway but excluded here as belt-and-suspenders.
  ':!docs/*-draft.md'
  ':!apps/web/src/lib/**'
  ':!**/check-secrets.sh'
  ':!.github/workflows/ci.yml'
  ':!pnpm-lock.yaml'
  ':!**/*.test.ts'
  ':!**/*.test.tsx'
)

found=0
for pat in "${PATTERNS[@]}"; do
  if git grep -nE -- "$pat" -- "${EXCLUDE[@]}"; then
    found=1
  fi
done

if [ "$found" -eq 1 ]; then
  echo
  echo "❌  potential secret found above. either remove it or extend the allowlist in scripts/check-secrets.sh." >&2
  exit 1
fi

echo "✓  no secrets found"
