# RPC Benchmark Dashboard

Continuous, regional, non-gameable benchmarking of Solana RPC providers.

## What this is

A benchmark that fires randomized, commit-revealed challenges at public Solana
RPC providers from several clouds and regions. It decides correctness by
majority vote across the benchmarked panel, guards against gaming with honeypot
spot-checks, and publishes a filterable leaderboard scoring latency, win rate,
reliability, correctness, and freshness.

It covers ~45 read methods — block and transaction lookups, account and token
reads, and chain-metadata calls. The full list is `EMITTED_METHODS` in
`packages/shared/src/types.ts`. Every challenge, sample, and score is open data
you can recompute from this repo against your own infrastructure.

## Architecture

```
Generator (HA) → Postgres ← Workers (per region × egress) → Dashboard (Next.js)
       │                              │
       └── Utility RPC (derivation)   └── Consensus across the benchmarked panel
                                            (majority vote, per vantage × mode)
```

The generator draws challenge params from live chain state (via a utility RPC
endpoint), commits to them under a hidden seed, and dispatches one assignment
per active vantage. Workers fire each challenge in parallel at every provider
and decide correctness locally by majority vote across the panel. Honeypots —
challenges replaying a known-good answer — are mixed in to catch a provider
serving wrong data. The seed is revealed after the challenge TTL, so anyone can
confirm the params were fixed before any provider responded.

## Run the benchmark yourself

There are two ways to run this, depending on how much you want to reproduce.
Both share the same methodology packages (`@rpcbench/methods`, `@rpcbench/runner`,
`@rpcbench/shared`) — challenge derivation, fanout, consensus, and scoring — so
the numbers are computed the same way. The difference is scope.

| | **Standalone CLI** (lite) | **Full reproduction** |
|---|---|---|
| Command | `pnpm --filter cli start -- …` (one process) | generator + workers + dashboard |
| Database | none | Postgres required |
| Secret / honeypots / commit-reveal | none | required |
| Vantage | your machine (single) | your own multi-region fleet |
| Correctness | consensus across your endpoints, or vs a `--reference` node | full consensus panel + honeypots + auditor |
| What you get | live per-provider table (latency, reliability, correctness) | the whole dashboard: leaderboard, eligibility, historical rollups, `/status`, `/raw` |
| Best for | "how do these endpoints look from here, right now?" | reproducing the published leaderboard end-to-end |

Feel free to start with the CLI to test out the benchmarks. Then set up the full system when you want to fully verify.

### Option A — standalone CLI (no database)

The fastest way to try it: bring your own endpoints, and it generates challenges,
benchmarks them from your machine, and prints a live table as samples land. No
Postgres, no secret, no honeypots — nothing to provision.

```bash
git clone https://github.com/helius-labs/rpc-perf-dash.git
cd rpc-perf-dash
pnpm install

pnpm --filter cli start -- \
  --provider helius=https://mainnet.helius-rpc.com/?api-key=XXX \
  --provider triton=https://your-triton-url \
  --provider alchemy=https://solana-mainnet.g.alchemy.com/v2/XXX \
  --provider quicknode=https://your-quicknode-url \
  --challenges 50
```

- **Correctness needs voters.** With **≥3 endpoints** it's decided by consensus
  among them (use ≥5 for robust dissent detection). With 1–2 endpoints, pass
  `--reference <url>` to score each against a node you trust; otherwise you get
  latency/reliability only (`correctness: n/a`).
- **Single vantage.** Latency is measured from your machine/network, not the
  multi-region cloud fleet — so **run it where your code runs** (your EC2
  instance, Lambda, container, etc.) to measure the latency your app actually
  sees.
- Full flag list, correctness regimes, and caveats:
  [`apps/cli/README.md`](apps/cli/README.md).

### Option B — full reproduction (database + continuous fleet)

Sets up the whole system: the generator, per-region
workers, honeypot anti-gaming, commit-reveal, and the Next.js dashboard. You
supply a Postgres instance and your own provider API keys; the repo does the
rest.

#### 1. Prerequisites

- Node 22+, pnpm 9+ (`corepack enable` works).
- A Postgres database. The [Neon](https://neon.tech) free tier is enough to
  start, though `samples` will outgrow its storage cap; any Postgres ≥ 14 works.
- API keys for the providers you want to benchmark (see the env list below).

#### 2. Install and configure

```bash
git clone https://github.com/helius-labs/rpc-perf-dash.git
cd rpc-perf-dash
pnpm install
cp .env.example .env.local
```

Fill in `.env.local`:

- `NEON_DATABASE_URL_POOLED` / `NEON_DATABASE_URL_DIRECT` — your Postgres
  connection strings. The `NEON_` prefix is just a naming convention; any
  Postgres works.
- `HELIUS_URL`, `TRITON_URL`, `ALCHEMY_URL`, `QUICKNODE_URL`, etc. —
  your provider endpoints. Any provider whose env is unset is skipped, so you
  can benchmark a subset. Correctness scoring needs at least **3** configured
  providers to form a consensus panel (see the minimal-eval note below).
- `UTILITY_RPC_URL` — the generator's chain-observation endpoint: it derives
  challenge inputs from live chain state, polls the tip slot, and seeds
  honeypots. It never votes on correctness, so it needs no independence from the
  panel (reusing a panel key here is fine). A paid, full-archive endpoint works
  best. Not on the leaderboard; workers never see it.
- `GENERATOR_SECRET` — HMAC secret for commit-reveal. Generate with
  `openssl rand -hex 32`.

#### 3. Bootstrap (one command)

With `.env.local` filled in, run:

```bash
pnpm bootstrap
```

It preflights your env (checking the DB URLs, `GENERATOR_SECRET`, `UTILITY_RPC_URL`,
and how many providers you configured), applies the schema, and seeds the honeypot
pool for **all three** honeypot-capable methods. Flags (after `--`):
`--honeypot-count N` (default 100), `--skip-seed`, `--skip-migrate`.

That's the whole setup — skip to step 4. The rest of this section is what `pnpm
bootstrap` does for you, if you'd rather run the pieces by hand or re-run one later:

- **Schema** — `pnpm db:migrate` (no Postgres extensions required).
- **Honeypots** — anti-gaming spot-checks that replay a known-good answer from
  deeply-finalized history (see `docs/methodology.md`). Only three methods have a
  stable historical answer to replay (`getBlock`, `getTransaction`,
  `getSignaturesForAddress`) — **not all ~45**. Seed them in one pass:

  ```bash
  pnpm --filter generator seed-honeypots --method all --count 100
  ```

  Ground truth comes from your utility endpoint, so spot-check the seeded rows
  before trusting them, and re-seed monthly to keep the pool fresh. An empty pool
  is fine — everything still runs, the honeypot anti-gaming check is just inactive
  (the generator warns at startup). Start at `--count 100`; the methodology target
  is ~2000 per method once you've spot-checked.

#### 4. Run it

Three processes, three terminals (or your supervisor of choice). All three read
the repo-root `.env` / `.env.local`.

```bash
pnpm dev:generator    # produces challenges every 30s
pnpm dev:worker       # claims assignments and fires calls at providers
pnpm dev:web          # dashboard at http://localhost:3000
```

For a single one-shot run instead of the continuous loop:

```bash
pnpm benchmark
```

This produces a small batch of challenges, scores the providers, and prints a
per-provider summary. Unlike the Option A CLI, it uses the configured provider
roster and writes its samples to your database (so the run also shows up on the
dashboard); it needs the same Postgres + `UTILITY_RPC_URL` + `GENERATOR_SECRET`
setup as the continuous fleet. If you just want a quick, DB-free comparison of
your own endpoints, use the standalone CLI (Option A) instead.

#### Minimal local eval

The smallest config that stands the whole system up on one machine:

```bash
# One Postgres database — pooled and direct can point at the same URL locally.
NEON_DATABASE_URL_POOLED=postgresql://localhost/rpcbench
NEON_DATABASE_URL_DIRECT=postgresql://localhost/rpcbench

# At least one BENCHMARKED provider — any of HELIUS_URL, TRITON_URL,
# ALCHEMY_URL, QUICKNODE_URL.
HELIUS_URL=https://mainnet.helius-rpc.com/?api-key=your-key-here

# The utility endpoint (challenge derivation + honeypot seeding). It can reuse a
# panel provider's endpoint — it never votes, so no independence is required.
UTILITY_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your-key-here

# Commit-reveal secret.
GENERATOR_SECRET=            # openssl rand -hex 32

# Loosen eligibility so the leaderboard ranks in minutes instead of hours.
TEST_MODE=1                  # dev only — weakens the public eligibility gate
```

Then run `pnpm db:migrate` once, start the three processes, and open
`http://localhost:3000`.

**What one provider can and can't show.** A single provider exercises the full
pipeline: challenges dispatch, samples flow, and latency/reliability show up on
`/status` and the provider page. But correctness needs at least 3 usable voters
(`MIN_CONSENSUS_VOTERS` in `packages/shared/src/consensus.ts`). With fewer, every
check ends `no_consensus`, and since eligibility counts only consensus-valid
samples, nobody ranks — even under `TEST_MODE=1`. Configure **3+ providers** to
replicate scoring end-to-end; they should appear on the leaderboard within a few
minutes under `TEST_MODE=1`.

#### Multi-region

Each worker process is one vantage: `(worker_provider, region, egress_path)`. Run
one worker per geo/egress combo you want on the leaderboard. The dashboard
discovers vantages from `worker_heartbeat`, so a new worker appears once it
starts heartbeating.

Production runs workers on AWS Fargate, GCP Cloud Run, Cloudflare Containers, and
bare-metal boxes. Local development usually runs a single worker.

#### Benchmarking your own provider

Add a `ProviderRow` to `packages/shared/src/providers.ts` with
`endpoints: [{ url: "env:YOUR_PROVIDER_URL" }]` and set that env var. Unset
providers are skipped, so the registry can stay a superset of what you run. If
you deploy across clouds, the same env var must reach every worker deploy path;
`docs/operations.md` § "Env var propagation matrix" lists them all.

## Deploying to your own infrastructure

### Quick setup — `pnpm bootstrap:creds`

One command provisions your credentials, whether or not you have Helius AWS access:

```bash
pnpm install
aws sso login --profile "$AWS_PROFILE"   # operators only — skip if you have no AWS access
pnpm bootstrap:creds
```

- **With AWS access** it pulls `.env` (app secrets) and deploy config (`.ops.env`
  + `infra/bare-metal/hosts.env`) from AWS Secrets Manager, runs `build:shared-env`,
  and probes GCP / Cloudflare / TSW auth — a `✓ / ✗ / -` checklist shows what's ready.
- **Without AWS access** it copies `.env.example` → `.env` for you to fill in and
  marks the AWS-only steps skipped (`-`), never failing.

Operators deploying TeraSwitch also need their SSH **public** key on each box's
`authorized_keys` (bootstrap reports reachability). The manual equivalent of each
step is below.

The `infra/` tree (AWS CDK, GCP Terraform, Cloudflare Containers, bare-metal
scripts) carries no account-specific values. Everything operator-specific comes
from your environment:

| What | How it's provided |
|---|---|
| AWS account | `CDK_DEFAULT_ACCOUNT` (from your AWS credentials) or `AWS_ACCOUNT_ID`; profile via `AWS_PROFILE` |
| Cloudflare account | `CLOUDFLARE_ACCOUNT_ID`, plus `wrangler login` |
| GCP project | `PROJECT_ID` env var (build/seed scripts and `-var=project_id` for terraform) |
| Bare-metal inventory | `infra/bare-metal/hosts.env` (gitignored — see the template in `infra/scripts/deploy-all-workers.sh`) |

**Secrets are sourced entirely from `.env` / `.env.local`** — no AWS Secrets
Manager account required. The worker fleets are fed by a generated shared env
file:

```bash
cp .env.example .env        # fill in your DB URL + provider keys
pnpm build:shared-env       # → /tmp/rpc-bench-worker.env.shared (from your .env)
bash infra/scripts/deploy-all-workers.sh   # deploys all four fleets
```

`build:shared-env` derives its key set from the provider registry
(`packages/shared/src/env-keys.ts`), so it never drifts as you add providers.
AWS Secrets Manager is optional and internal-only — if you use it, `pnpm seed:aws`
mirrors `.env` into it (and `build:shared-env --from aws` reads it back).

`docs/operations.md` is the full runbook: deploy order, per-cloud gotchas,
changing an endpoint, and recovery.

### Naming

The repo is `rpc-perf-dash`, the package scope is `@rpcbench/*`, and cloud
resources use an `rpc-bench-*` prefix. All three refer to the same system.

## Methodology

See [`docs/methodology.md`](docs/methodology.md), and read it before drawing
conclusions from rankings. It covers the commit-reveal protocol, consensus
decision rules, per-method projection and equivalence rules, scoring formulas,
eligibility thresholds, and the anti-gaming threat model (honeypots included).

## Reproducibility caveat

Running this against any provider's free tier will hit monthly credit caps before
generating enough samples for a stable leaderboard. Sustained shared cadence
needs paid tiers on every benchmarked provider. The methodology page covers this
in full and treats every provider the same way; only the operator's
infrastructure cost differs.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for code style, secret-handling rules,
and DB-access conventions. Security reports: see [`SECURITY.md`](SECURITY.md).

## License

[Apache-2.0](LICENSE).
