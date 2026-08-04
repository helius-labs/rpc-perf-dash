# Changelog

Product releases for the RPC Benchmark Dashboard, following
[semantic versioning](https://semver.org/). This tracks the software: features,
DB schema, infra, and fixes. Methodology and scoring behavior is documented in
[`docs/methodology.md`](docs/methodology.md).

## 1.2.0 — 2026-07-28

- Added a **transaction-sending ("sends") archetype** and a new **Sends**
  leaderboard tab (`/sends`). Instead of consensus-scored reads, it broadcasts
  real transactions through competing send paths and scores them against the
  chain on two axes: landing rate (reliability) and slot latency (latency).
  Scenarios: `transfer`, `raydium_swap`, `orca_swap`.
- **Confirmation folded into the generator** (no separate service): a ~2s poll
  loop reads in-flight sends and classifies them via `getSignatureStatuses`
  (landed / reverted / not_landed / submit_error) with a single-winner write,
  reaping unlanded sends at ~80s. No Yellowstone/gRPC dependency.
- Migration `0002`: an `archetype` discriminator on `challenges` /
  `challenge_assignments`; new `send_pending`, `landing_tx_results`,
  `landing_wallet_balances`, `send_wallets`, `send_service_status` tables; and
  `send_rollups_5m` / `send_rollups` / `send_leaderboard_agg` precompute.
  Additive — read scoring semantics are unchanged, so no read-methodology
  redeploy is required.
- Send targets: the **5 benchmarked read providers** (Helius, Alchemy, Triton,
  QuickNode, Chainstack). We measure plain JSON-RPC `sendTransaction` on each
  provider's standard endpoint — **no tips, no relays, no premium send paths** —
  an apples-to-apples landing comparison. Sends reuse the already-seeded read
  URLs, so there are **no new worker secrets**.
- New secret: generator-only `SEND_MASTER_KEYPAIR` (funds the send wallets). The
  generator's confirm poll reuses the shared `UTILITY_RPC_URL` — no dedicated
  confirm secret. Swap pool config in `SEND_RAYDIUM_CONFIG` / `SEND_ORCA_CONFIG` +
  `SEND_POOL_RPC_URL` for pool reads. Gated by the `SENDS_ENABLED` kill-switch
  (off = no send challenges, no SOL spent).
- New **send methodology version** (`SEND_METHODOLOGY_VERSION`), versioned
  independently of the read `METHODOLOGY_VERSION` (still 4).

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
