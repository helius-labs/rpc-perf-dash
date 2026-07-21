# Changelog

Product releases for the RPC Benchmark Dashboard, following
[semantic versioning](https://semver.org/). This tracks the software: features,
DB schema, infra, and fixes. Methodology and scoring behavior is documented in
[`docs/methodology.md`](docs/methodology.md).

## 1.0.0 — 2026-07-17

First public release.

- Majority-consensus correctness across the benchmarked panel (Helius, Triton,
  Alchemy, QuickNode), with honeypot spot-checks as the anti-gaming backstop.
- ~45 read methods with per-method projection and equivalence rules.
- Commit-reveal challenge protocol with a 30s TTL and honeypot spot-checks.
- Per-region, per-egress vantages; filterable leaderboard scoring latency, win
  rate, reliability, correctness, and freshness.
- Reproducible end-to-end against your own Postgres and provider keys.
