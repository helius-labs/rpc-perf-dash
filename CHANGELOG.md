# Changelog

Product releases for the RPC Benchmark Dashboard, following
[semantic versioning](https://semver.org/). This tracks the software: features,
DB schema, infra, and fixes. Methodology and scoring behavior is documented in
[`docs/methodology.md`](docs/methodology.md).

## 1.1.0 — 2026-07-23

- Added Chainstack to the benchmarked panel (now five providers: Helius,
  Triton, Alchemy, QuickNode, Chainstack). Verified live against a Chainstack
  mainnet endpoint across all ~45 emitted methods: `simulateBundle` and
  `getTransactionsForAddress` aren't served (Jito extension / custom indexer
  API, same as the existing QuickNode exclusions), and `getTokenLargestAccounts`
  is restricted to dedicated nodes on the shared tier. Every other method is
  fully supported.
- Bumped `METHODOLOGY_VERSION` to 4: adding Chainstack changes
  `getStakeMinimumDelegation`'s consensus rule from a relaxed 2-of-3 majority
  to the default 3-of-4 strict majority (a real decision-rule change, not just
  more data), so results before and after this change are scored under
  different semantics and must not be blended. Deploying this requires the
  full-fleet redeploy in `docs/operations.md` § "Quick reference: full prod
  deploy after a methodology change."

## 1.0.0 — 2026-07-17

First public release.

- Majority-consensus correctness across the benchmarked panel (Helius, Triton,
  Alchemy, QuickNode), with honeypot spot-checks as the anti-gaming backstop.
- ~45 read methods with per-method projection and equivalence rules.
- Commit-reveal challenge protocol with a 30s TTL and honeypot spot-checks.
- Per-region, per-egress vantages; filterable leaderboard scoring latency, win
  rate, reliability, correctness, and freshness.
- Reproducible end-to-end against your own Postgres and provider keys.
