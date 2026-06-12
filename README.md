# RPC Benchmark Dashboard

Continuous, regional, non-gameable benchmarking of Solana RPC providers.

## What this is

A multi-vantage benchmark that fires randomized, commit-revealed challenges at public Solana RPC providers from several clouds and geos, decides correctness by majority consensus across the benchmarked panel, cross-checks each consensus answer against an independent auditor endpoint, and publishes a filterable leaderboard scoring latency, win rate, reliability, correctness, and freshness.

Current method coverage: ~44 read methods, from the high-volume trio (`getBlock`, `getTransaction`, `getSignaturesForAddress`) through account/token reads to chain-metadata calls — the canonical emitted list is `allMethodBucketCombos()` in `apps/generator/src/index.ts`. Every challenge, every sample, and every score is open data — recomputable from this repo against your own infrastructure.

## Architecture

```
Generator (HA) → Postgres ← Workers (per region × egress) → Dashboard (Next.js)
       │                              │
       └── Auditor (utility RPC)      └── Consensus across the benchmarked panel
              (cross-check)                  (majority vote, per vantage × mode)
```

The generator commits to challenge params via a hidden seed, attaches the auditor's answer to the challenge, and dispatches one assignment per active vantage. Workers fire each challenge in parallel at every benchmarked provider and decide correctness locally via majority consensus across the panel. Each consensus answer is cross-checked against the auditor reference — disagreement marks the challenge `consensus_disputed` and excludes it from scoring. A periodic finality re-verification job re-fetches finalized challenges from the auditor and publishes the consensus-accuracy metric. The seed is revealed after the challenge TTL so anyone can verify the params were locked in before any provider response could influence them.

## Run the benchmark yourself

The benchmark is reproducible end-to-end. You provide a Postgres instance and your own provider API keys; the repo does the rest.

### 1. Prerequisites

- Node 22+, pnpm 9+ (`corepack enable` works).
- A Postgres database. [Neon](https://neon.tech) free tier is enough to start; you'll outgrow the storage cap once `samples` accumulates (Neon Launch at $19/mo, or any Postgres ≥ 14).
- API keys for the providers you want to benchmark (see env list below).

### 2. Install and configure

```bash
git clone https://github.com/helius-labs/rpc-perf-dash.git
cd rpc-perf-dash
pnpm install
cp .env.example .env.local
```

Fill in `.env.local`:

- `NEON_DATABASE_URL_POOLED` / `NEON_DATABASE_URL_DIRECT` — your Postgres connection strings (the names are historical; any Postgres works).
- `HELIUS_API_KEY`, `TRITON_URL`, `ALCHEMY_URL`, `QUICKNODE_URL`, etc. — your provider endpoints. Any provider whose env is unset is silently skipped, so you can benchmark a subset.
- `UTILITY_RPC_URL` (+ optional `UTILITY_RPC_URL_2`, `UTILITY_RPC_URL_3` for failover) — an RPC endpoint that is **not** on the leaderboard, used for generator-side preflight (challenge derivation) AND as the neutral **auditor** that cross-checks panel consensus. The endpoint operator MUST be independent of every benchmarked provider — `assertAuditorIndependent()` fails the generator at startup if the host overlaps a panel member's host, but confirming the configured endpoint's real operator is a manual prerequisite. A paid, full-archive third-party endpoint works well.
- `GENERATOR_SECRET` — HMAC secret for the commit-reveal protocol. Generate with `openssl rand -hex 32`.

### 3. Apply the schema

```bash
pnpm db:migrate
```

No extensions are required — percentile aggregation uses plain
`percentile_cont()` (the original `tdigest`-extension path was dropped in
migration 0003 because managed Postgres providers commonly don't allow it).

### 4. Run it

Three processes, three terminals (or your favorite supervisor):

```bash
pnpm dev:generator    # produces challenges every 30s
pnpm dev:worker       # claims assignments and fires calls at benchmarked providers
pnpm dev:web          # dashboard at http://localhost:3000
```

For a single one-shot run (no continuous loop), use:

```bash
pnpm benchmark
```

This produces a small batch of challenges, scores the providers, and prints a per-provider summary.

### Multi-region

Each worker process is one vantage — `(worker_provider, region, egress_path)`. Run one worker per geo/egress combo you want to represent on the leaderboard. The dashboard auto-discovers vantages from `worker_heartbeat`, so a new worker just needs to start heartbeating to appear.

Production deploys workers on AWS Fargate, GCP Cloud Run, Cloudflare Containers, and bare-metal boxes. Local development typically runs a single worker.

### Benchmarking your own provider

Add a `ProviderRow` to `packages/shared/src/providers.ts` with `endpoints: [{ url: "env:YOUR_PROVIDER_URL" }]` and set that env var. Any provider whose env is unset is silently skipped, so the registry can stay a superset of what you actually run. If you deploy across clouds, the same env var has to reach every worker deploy path — `docs/operations.md` § "Env var propagation matrix" lists all of them.

## Deploying to your own infrastructure

The `infra/` tree (AWS CDK, GCP Terraform, Cloudflare Containers, bare-metal scripts) carries no account-specific values — everything operator-specific comes from your environment:

| What | How it's provided |
|---|---|
| AWS account | `CDK_DEFAULT_ACCOUNT` (from your AWS credentials) or `AWS_ACCOUNT_ID`; profile via `AWS_PROFILE` (default `dev`) |
| Cloudflare account | `CLOUDFLARE_ACCOUNT_ID`, plus `wrangler login` |
| GCP project | `PROJECT_ID` env var (build/seed scripts and `-var=project_id` for terraform) |
| Bare-metal inventory | `infra/bare-metal/hosts.env` (gitignored — see the template comment in `infra/scripts/deploy-all-workers.sh`) |

`docs/operations.md` is the full runbook: deploy order, per-cloud gotchas, and recovery procedures.

### Naming

The repo is `rpc-perf-dash`; internal package scope is `@rpcbench/*`; cloud resources use an `rpc-bench-*` prefix. All three refer to the same system.

## Methodology

See [`docs/methodology.md`](docs/methodology.md). The methodology is the product — read it before drawing conclusions from rankings. Topics covered: commit-reveal protocol, **consensus decision rules**, the **auditor cross-check and deferred finality re-verification**, projection / equivalence rules per method, scoring formulas, eligibility thresholds, and the anti-gaming threat model.

## Reproducibility caveat

Cloning this repo and running it against the public Helius free tier (or any provider's free tier) will hit per-month credit caps before generating enough samples to populate a stable leaderboard. Sustained shared cadence requires paid tiers on every benchmarked provider. The methodology page documents this in full and treats every provider symmetrically — the operator's infrastructure cost is the only thing that differs.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for code style, secret-handling rules, and DB-access conventions. Security reports: see [`SECURITY.md`](SECURITY.md).

## License

[Apache-2.0](LICENSE).
