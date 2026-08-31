# Changelog

Product releases for the RPC Benchmark Dashboard, following
[semantic versioning](https://semver.org/). This tracks the software: features,
DB schema, infra, and fixes. Methodology and scoring behavior is documented in
[`docs/methodology.md`](docs/methodology.md).

## 1.2.1 — 2026-08-31

- **Quicknode votes on `getTransactionsForAddress` again.** Its variant had
  been declared `unsupported_methods` because it was non-comparable by
  construction: a bare-array result instead of the `{data, paginationToken}`
  envelope, always-full details (ignoring `transactionDetails: "signatures"`),
  `filters.slot.lte` ignored, string `commitment` rejected with -32602, and
  `maxSupportedTransactionVersion` required even in signatures mode. Re-probed
  live 2026-08-31: every one of those five defects is gone, and its responses
  are byte-equal with Helius and Alchemy across 12 challenges × both buckets ×
  cold+warm (72 samples, zero divergence). Removing the declaration restores a
  3-voter panel.
- This is the second panel change for the method inside a month: Triton
  dropped it on 2026-08-20 (-32601, still true), which had taken it down to
  2 voters and the relaxed `{ minGroup: 2, minVoters: 2 }` pairwise-agreement
  floors. It's now back to `{ minGroup: 2, minVoters: 3 }` — all three must
  answer, and a 2-1 split is decided with the deviator attributed.
- `METHODOLOGY_VERSION` stays at **4**, as it did for the 2026-08-20 change, so
  history is preserved rather than reset. Consequence: this method's
  correctness series changes shape twice within version 4 — a step there is a
  rule change, not a provider regression. Documented in
  `docs/methodology.md` § Consensus and on the methodology page.
- Deploy: generator + workers (no DB migration, no web-only path — the panel
  size is compiled into `@rpcbench/shared`).

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
  Quicknode, Chainstack). We measure plain JSON-RPC `sendTransaction` on each
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
  Triton, Alchemy, Quicknode, Chainstack). Verified live against a Chainstack
  mainnet endpoint across all ~45 emitted methods: `simulateBundle` and
  `getTransactionsForAddress` aren't served (Jito extension / custom indexer
  API, same as the existing Quicknode exclusions), and `getTokenLargestAccounts`
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
  Alchemy, Quicknode), with honeypot spot-checks as the anti-gaming backstop.
- ~45 read methods with per-method projection and equivalence rules.
- Commit-reveal challenge protocol with a 30s TTL and honeypot spot-checks.
- Per-region, per-egress vantages; filterable leaderboard scoring latency, win
  rate, reliability, correctness, and freshness.
- Reproducible end-to-end against your own Postgres and provider keys.
