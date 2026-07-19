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
   - A utility-endpoint URL (`UTILITY_RPC_URL`) — the generator's chain-observation RPC (challenge derivation, slot polling, honeypot seeding). Any RPC endpoint works; it never votes on correctness (see `docs/methodology.md`).
5. `pnpm db:migrate` to apply the schema.
6. `pnpm --filter generator seed-honeypots --method <getBlock|getTransaction|getSignaturesForAddress> --count 100` to seed the anti-gaming honeypot pool (re-run monthly; the generator warns at startup if the pool is empty).
7. `pnpm dev:generator` to start producing challenges; `pnpm dev:worker` to start hitting providers.

## Reproducing published results

The production benchmark Helius operates runs on its own internal endpoints (Helius traffic is $0 for it to operate). A third-party reproducer running this repo against the public Helius free tier will hit the published ~1M-credit/mo cap and won't be able to sustain shared cadence on Helius without a paid tier. See `docs/methodology.md` § "Operator vs reproducer cost" for the full disclosure.

## Secret safety

- Never commit `.env.local` or any file containing real API keys.
- A pre-commit hook (`.githooks/pre-commit`, wired automatically by `pnpm install` via the root `prepare` script) scans for likely API key patterns; CI runs the same scan on push. Operators can extend it with deployment-specific patterns in the gitignored `packages/shared/scripts/check-secrets.local`.
- CI holds no cloud credentials — it only typechecks and secret-scans. Deploys run from operator machines.

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Comments must earn their place: write them for the non-obvious *why* (tolerances, failure modes, protocol constraints) — never to narrate what the code already says. The scoring/consensus code deliberately carries dense why-comments; match that bar there.
- DB access goes through `packages/db/src/{samples,control,consensus}.ts`. Hot-path queries do not use Postgres-specific JSONB operators directly — keep the ClickHouse-migration door cheap.
