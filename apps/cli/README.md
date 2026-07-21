# `cli` — standalone BYO-keys RPC benchmark

Run the RPC benchmark methodology **locally, against your own endpoints**. No
database, no secret, no cloud infra — you bring the keys, it generates its own
challenges and prints a live table as samples come in.

It reuses the production methodology packages (`@rpcbench/methods`,
`@rpcbench/runner`, `@rpcbench/shared`) but touches nothing in the running
system: no DB writes, no rollups, no commit-reveal, no auditor-independence
check.

This is **"Option A"** in the [root README](../../README.md#run-the-benchmark-yourself).
If you want the full published system — the dashboard, honeypot anti-gaming,
commit-reveal, eligibility, and a multi-region fleet — see **Option B** there
(it needs Postgres and provider keys).

## Usage

```bash
pnpm install            # once, from the repo root

# Keep API keys OFF the command line: reference them as env:VAR. The command
# line is echoed into shell history / pnpm output, so a keyed URL leaks there.
export HELIUS_URL=https://mainnet.helius-rpc.com/?api-key=XXX
export TRITON_URL=https://your-triton-url

pnpm --filter cli start -- \
  --provider helius=env:HELIUS_URL \
  --provider triton=env:TRITON_URL \
  --challenges 50
```

Everything after `--` is passed to the CLI. Run `--help` for the full list.

With no `--methods`, an interactive arrow-key method picker opens (on a TTY) —
so you can choose methods without flags.

### Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--provider name=url` | — | An endpoint to benchmark. **Repeatable, ≥1 required.** `name` is a display label only. `url` may be literal or **`env:VAR_NAME`** (resolved from the environment — keeps API keys off the command line). |
| `--providers-file path` | — | Read provider entries from a file: one `name=url` per line (`#` comments allowed). Merged with `--provider` flags. Handy as a gitignored `providers.env`. |
| `--reference url` (alias `--auditor`) | — | Score every endpoint against this trusted node instead of panel consensus. Also accepts `env:VAR`. |
| `--challenges N` | `30` | How many challenges to run. |
| `--methods a,b,c` | all | Restrict to specific JSON-RPC methods (skips the picker). |
| `--pick` | off | Force the interactive arrow-key method picker (TTY): `←/→` move · `space` toggle · `a`/`n` all/none · `enter` run · `q` cancel. Opens by default when `--methods` is omitted. |
| `--buckets substr` | — | Only run buckets whose name contains `substr` (e.g. `archival`). |
| `--concurrency N` | `3` | Challenges in flight at once. |
| `--seed N` | random | Deterministic challenge selection for reproducible runs (given the same chain tip). |
| `--json` | off | Emit machine-readable JSON instead of the live table. |
| `--dump path` | — | Write a per-challenge **audit trail** (method, params, each endpoint's status/latency/correctness/response hash, and the consensus decision) as JSON — inspect exactly what was compared, and replay any challenge by hand. |
| `-h`, `--help` | — | Show usage and exit. |

## How correctness is decided (read this)

Correctness is not "does it match one node" — it's decided the same way the
hosted benchmark does it, and that has real implications for how many endpoints
you need:

- **1–2 endpoints, no `--reference`** → `correctness: n/a`. Consensus can't form;
  you still get latency / reliability / freshness.
- **`--reference <url>`** → each endpoint is scored directly against your trusted
  node. Works with any number of endpoints. Use this if you have a node you
  trust as ground truth.
- **≥3 endpoints (default)** → correctness by majority vote across your
  endpoints. The agreement threshold (`minGroup`) is **method-dependent** (2 or
  3), inherited from the benchmarked roster:
  - **At exactly 3 endpoints**, most methods require **unanimity** — a 2‑1
    disagreement is dropped (`no_consensus`) and *not* attributed to the
    dissenter. Three methods (`simulateBundle`, `getTransactionsForAddress`,
    `getStakeMinimumDelegation`) instead attribute a 2‑1 dissent.
  - **Use ≥5 endpoints** for uniform, robust dissent detection.

The header line tells you which regime is active every run.

## Caveats

- **Single vantage.** Latency is measured from *your machine / network*, not the
  multi-region cloud fleet the hosted dashboard uses. It answers "what do I see
  from here," not "what's fastest globally."
- **Method-derived `minGroup`.** The consensus threshold comes from the global
  benchmarked roster's per-method panel, not from your endpoint count — see
  above. This is why ≥5 endpoints is the recommendation for correctness work.
- **Provider IDs are namespaced** internally (`byo-0`, `byo-1`, …) so a display
  name like `quicknode` can't collide with a roster entry and silently skew
  results. Names are display-only.

## Cross-checking against the operator tool

The operator one-shot (`pnpm --filter generator benchmark`) hits the same
methodology with the configured roster + DB. Against the same endpoints, latency
should land in the same ballpark — but note the two use different `provider_id`s
(this CLI namespaces to `byo-<n>`), so it's a latency/reliability sanity check,
not a row-for-row match.

## Not included (yet)

- **Multi-region** runs (e.g. via ephemeral cloud machines) — this CLI is local
  only.
- **npx distribution** — run it from a clone via `pnpm --filter cli start`.
