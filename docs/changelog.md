# Changelog

Public methodology changes will be logged here once the benchmark is live and externally referenced. Each entry will state the change, its motivation, and (if applicable) the `methodology_version` bump that forks rollups so historical leaderboards never mix old and new semantics.

_Pre-launch. All current behavior is implementation-phase iteration; the changelog starts accumulating once the benchmark is publicly referenced. Pre-launch methodology-version bumps are recorded below for continuity._

## 2026-06-12 — archival buckets measure true archive depth

- **Archival rebanded to tip − 182…365 epochs (≈1–2 years)**, from tip − 1…10
  epochs (~2–20 days). The old band sat inside providers' recent-ledger
  retention / warm storage, so it measured caches rather than archive reads.
  Applies to `getBlock`, `getTransaction`, `getBlockTime`, `getBlocks`,
  `getBlocksWithLimit`, `getBlockCommitment`.
- **New `getSignaturesForAddress` archival bucket** (`archival__frozen__l100`):
  a window pinned strictly `before` a 1–2-year-old anchor signature. The
  window is immutable, so consensus is strict byte-equal (no Jaccard
  tolerance — that would mask real archive gaps).
- **Archival/honeypot fanout timeout raised 5s → 10s** (cold archive reads).
  Latency comparisons stay within-bucket; timeouts still count against
  Reliability.
- Bumps the methodology version as usual, forking rollups/leaderboards; no
  historical data is re-scored.
