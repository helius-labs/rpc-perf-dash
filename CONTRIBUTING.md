# Contributing

## Local setup

1. **Node 22+, pnpm 9+.** `corepack enable` works.
2. `pnpm install` from the repo root.
3. Provision a Postgres ≥ 14 database (any host works; we run Neon — its free
   tier covers the control plane, but expect to need a paid tier once
   `samples` accumulates). No extensions are required.
4. Copy `.env.example` to `.env.local` and fill in:
   - Your Postgres connection strings (pooled + direct; the NEON_* names are historical — any Postgres works).
   - Your own RPC provider API keys for the providers you want to benchmark. We don't distribute Helius's keys; reproducers run with their own.
   - A utility-endpoint URL (`UTILITY_RPC_URL`) — any RPC endpoint NOT operated by a benchmarked provider. It serves generator preflight and the auditor cross-check (see `docs/methodology.md`).
5. `pnpm db:migrate` to apply the schema.
6. `pnpm dev:generator` to start producing challenges; `pnpm dev:worker` to start hitting providers.

## Reproducing published results

The Helius-operated production benchmark uses operator-internal endpoints (specifically Helius traffic is $0 to operate). A third-party reproducer running this repo against the public Helius free tier will hit the published ~1M-credit/mo cap and won't be able to sustain shared cadence on Helius without a paid tier. See `docs/methodology.md` § "Operator vs reproducer cost" for the full disclosure.

## Secret safety

- Never commit `.env.local` or any file containing real API keys.
- A pre-commit hook (`.githooks/pre-commit`, wired automatically by `pnpm install` via the root `prepare` script) scans for likely API key patterns; CI runs the same scan on push. Operators can extend it with deployment-specific patterns in the gitignored `packages/shared/scripts/check-secrets.local`.
- CI holds no cloud credentials — it only typechecks and secret-scans. Deploys run from operator machines.

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Default to no comments. Add one only when the *why* is non-obvious.
- DB access goes through `packages/db/src/{samples,rollups,control}.ts`. Hot-path queries do not use Postgres-specific JSONB operators directly — keep the ClickHouse-migration door cheap.
