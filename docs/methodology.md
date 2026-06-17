# Methodology

This page explains how the benchmark works: how we choose what to test, how we
decide which answer is right, and how the score is built. The short version is
right below; open any section for the details.

## In short

- **What it measures.** For each provider, in each region, on each RPC method:
  how fast it responds (p50/p95), how often it's the fastest *correct* answer
  (win rate), how reliable it is, and whether its data is right. The Overview
  headline score then **blends those across a set of methods and regions** — a
  *workload preset* (Balanced / Trading / Apps) — into one number.
- **Why you can trust it.** Every test query is drawn from live on-chain data and
  locked in (hashed) *before* any provider answers, then revealed afterward, so
  nobody can precompute answers or cherry-pick results. Tests expire after 30
  seconds.
- **Where it runs.** We send the same requests from several cloud regions at once.
  The leaderboard blends regions, leaning on NA-East and EU-Central (our two
  best-covered). You can filter by region on the Performance page.
- **How it's scored.** Per (method, region): `0.25·Latency + 0.25·Win-rate +
  0.25·Reliability + 0.20·Correctness + 0.05·Freshness`. The Overview blends
  that across the preset's regions and methods into one score; pick a preset
  (Balanced / Trading / Apps) and tune the component **and** per-method weights
  on the Overview.
- **Check it yourself.** Open `/raw?challenge=<id>` for any test to see the
  pinned inputs, the revealed seed, every provider's response, and the verdict.

## Goals

1. **Open and verifiable.** The code is public, and every test's inputs are
   hash-committed up front and revealed afterward, so anyone can re-derive and
   check them.
2. **Can't be gamed.** Queries come from live chain data and expire in 30s, so a
   provider can't spot a benchmark request and serve a cached or faked answer.
3. **Region- and cloud-aware.** Pick the region and cloud that match where your
   app runs, so the numbers reflect your use case. The leaderboard is a filter
   you control, not one fixed ranking.

## How the system works

Each test (we call it a "challenge") moves through these steps:

1. **Observe**: we watch live chain state (recent slots, signatures, accounts)
   and draw the test inputs from it.
2. **Commit**: we pick a method and input, hash it together with a hidden seed,
   and publish the hash. Nobody can see what's coming, and we can't claim we
   changed it later.
3. **Audit**: we also send the request to an independent reference endpoint that
   never votes; it only flags disagreements.
4. **Dispatch**: the test is handed to a few randomly-chosen worker locations.
5. **Benchmark**: each worker hits every provider at the same time, twice: once
   on a fresh connection (cold) and once on a kept-open one (warm).
6. **Consensus**: the providers' answers are compared, the majority answer is
   taken as correct, and it's double-checked against the independent reference.
7. **Score**: results roll up into the leaderboard numbers.
8. **Reveal**: after the 30s window, the seed is published so anyone can confirm
   the inputs were locked in beforehand.

## Consensus decision rules

How do we decide which answer is "correct" without trusting any single provider?
We compare everyone's response and go with the **majority**. A provider counts as
correct if it's in the majority group; off on its own means incorrect.

The exact rules, per test (cold and warm are judged separately). Let `n` be the
number of providers that returned a usable answer, and `g` the size of the
largest group that agrees:

| Condition | Outcome |
|---|---|
| Fewer than 3 usable answers (`n < 3`) | **Ambiguous**: too few responses; the test is thrown out |
| No group of 3 or more agrees (`g < 3`; floor is 2 on a structurally-3-voter panel, see below) | **Ambiguous**: thrown out |
| The largest group isn't a clear majority (e.g. a 2–2 tie) | **Ambiguous**: thrown out |
| A group of 3+ forms a clear majority | That group is **correct**; everyone outside it is a **dissenter** |

The voting panel is **Helius, Triton, Alchemy, and QuickNode**: four voters on
most methods. A provider whose tier structurally can't serve a method
(declared via `unsupported_methods` in `packages/shared/src/providers.ts`) is
a **non-voter** there: its samples are marked `tier_method_unsupported` and
dropped from both the correctness and reliability denominators — disclosed
limitation, not a failure. Two methods run as 3-voter panels today:

- `simulateBundle` — a Jito extension QuickNode's tier doesn't serve
  (-32601).
- `getTransactionsForAddress` — QuickNode serves a **non-comparable variant**
  (bare-array result instead of the `{data, paginationToken}` envelope,
  always-full transaction details, slot filter ignored; verified 2026-06-12),
  so its answers can never match the panel's.

On a structurally-3-voter panel, the "group of 3 or more" floor is lowered to
a **2-1 strict majority** (it would otherwise demand unanimity, and a lone
deviator could never be scored). Two byte-equal agreements out of three
independent providers is decisive — and the auditor cross-check still
backstops the case where the agreeing pair is wrong. So a provider that
deviates alone on a 3-voter method (e.g. an empty or incomplete answer) is a
**dissenter and scores incorrect**, exactly as on the 4-voter panel. The
`n ≥ 3` usable-voters floor is unchanged: if one of the three doesn't answer
usably, the test is still thrown out.

Each test also carries a reference answer fetched from the utility (auditor)
endpoint at generation time. If the panel majority disagrees with that
reference, every sample for the test is excluded from scoring
(`consensus_disputed`) — a tripwire for the case where the majority itself is
wrong.

## Deferred finality re-verification

Majority consensus is judged live, at the moment of the test. As a second,
delayed check: about 10 minutes after a test is generated — well past Solana's
finalization timeline, when the canonical answer is immutable — a periodic job
re-fetches the same request from the auditor and compares it against the
stored consensus answer. The result is written to `consensus_audit`, one row
per test (idempotent), in batches of 25, covering tests less than 24 hours
old.

Only tests whose answers cannot legitimately change are eligible: the test
reached consensus (not ambiguous, not a honeypot, reference present), and the
method/bucket is finalized or immutable in its semantics — `getBlock` on
non-tip buckets, `getTransaction`, and archival `getSignaturesForAddress`
(epoch buckets). Tip-active methods like `getSlot` are excluded because their
correct answers move with the chain.

This catches the failure mode the live vote can't: the panel majority agreeing
on a wrong answer. The match rate is published as the consensus-accuracy
metric on the provider health panel, and each test's audit verdict appears on
its `/raw` page.

## Scoring

Each provider gets five sub-scores (0–100), combined into one number:

```
L = Latency: how fast it responds (p50 + p95), vs. the panel's fastest
W = Win rate: how often it gave the fastest correct answer
R = Reliability: share of calls that came back OK
C = Correctness: share of answers that matched consensus
F = Freshness: how up-to-date the returned data is

score = 0.25·L + 0.25·W + 0.25·R + 0.20·C + 0.05·F
```

Latency (L) and win rate (W) are kept separate on purpose: L rewards a tight,
consistently-fast distribution, while W rewards actually being first on
head-to-head requests. They can disagree, and that's useful to see. Timeouts hurt
Reliability, not Correctness, so a flaky provider isn't punished twice for the
same call. The default weights split evenly across speed and quality; you can
re-weight them with the presets (or the sliders) on the Overview.

That five-part formula produces a score **per (method, region)**. The Overview
headline then blends those up two more levels: across regions, then across the
methods in the active preset.

### Region weights

The "Overall" view blends regions with these default weights:

| Region | Weight |
|---|---|
| NA East | 0.35 |
| EU Central | 0.35 |
| AP Northeast | 0.15 |
| NA West | 0.05 |
| EU West | 0.05 |
| AP Southeast | 0.05 |

For each provider the weights are re-normalized over only the regions where it
qualifies, so a provider that isn't in a region isn't penalized for it. A preset
may also use a **subset** of regions (e.g. Trading scores only NA-East,
EU-Central, and AP-Northeast); the same re-normalization applies over that
subset.

### Workload presets

The Overview ranks by a *workload preset* — a set of methods + per-method weights
+ a region subset + the five component weights above. A provider's per-(method,
region) scores are region-blended per method, then **method-blended** (a
weighted average over the preset's methods, re-normalized over the methods the
provider qualifies in — same idea as the region blend).

| Preset | Focus | Methods | Regions |
|---|---|---|---|
| **Balanced** | Even, everything | all scored methods, equal weight | all 6 |
| **Trading** | Latency / win-rate | getLatestBlockhash, getSlot, getAccountInfo, getProgramAccounts | NA-East, EU-Central, AP-Northeast |
| **Apps** | Reliability / correctness | getTransaction, getSignaturesForAddress, getProgramAccounts, getTokenAccountsByOwner, getAccountInfo, getMultipleAccounts | all 6 |

The latency *percentiles* (p50/p95) are deliberately **not** blended across
methods on the headline board — an average p50 across, say, getSlot and
getProgramAccounts isn't a real latency for anything. Raw per-method latency
lives in each provider's per-method drill-down and on the Performance page. The
sum/ratio metrics (win rate, calls, success, failure breakdown) *do* blend
meaningfully and are shown.

`sendTransaction` is intentionally absent from every preset: it's a broadcast
with no replayable correct answer to validate against, so it isn't scored.

### Minimum method coverage

Because a preset blends several methods, a provider that qualifies on only one or
two of them could otherwise top the board on a sliver of the workload. So a
provider is ranked only if it qualifies in methods worth **≥60% of the preset's
total method weight**; below that it's shown as "insufficient method coverage"
rather than ranked. The 60% bar is comfortably clear of every current provider
(each qualifies on ~93%+ of the method universe) — it's a guard for sparse
windows and future entrants.

### Who qualifies

To appear ranked, a provider needs enough data to be meaningful: currently a 4h
window, at least 50 samples per (provider × method × region), ≥80% reliability,
≥80% correctness, and a ≥95% honeypot pass rate (Wilson lower bound). Below
that, it shows with a "below thresholds" note. Under a preset, that gate is
applied per (method, region) before the blend, and the coverage gate above is
applied to the blended result.

## Projection & equivalence

Before comparing answers, we boil each response down to just the parts that
*should* match (ignoring incidental fields like timestamps or list ordering),
then compare them with the right rule for that method: an exact match, a
similarity threshold, a slot tolerance, or a well-formedness check. Browse every
method and how it's checked:

| Method | Hashed | Equivalence rule |
|---|---|---|

*The full per-method rules live in `apps/web/src/app/methodology/methods.data.ts`
and render as the interactive method explorer on the live methodology page.*

### Custom methods: getTransactionsForAddress

`getTransactionsForAddress` is the first non-standard method in the benchmark
(an indexer-backed address-history API served by Helius, Triton, and Alchemy;
QuickNode's variant is non-comparable — see the consensus section). Two design
choices differ from its standard-method sibling `getSignaturesForAddress`:

- **Slot-pinned challenges.** Every test carries
  `filters: { slot: { lte: pin } }` with `pin = tip − 5000` (~35 minutes,
  deeply finalized) and `sortOrder: "desc"`. "The newest ≤limit transactions
  at or before the pin" is an immutable answer: the finalized-semantics tip
  drift that forces `getSignaturesForAddress` into a Jaccard tolerance lives
  entirely at the tip, which the pin excludes. Both buckets therefore use
  **strict byte-equal** matching — necessary, since a 3-voter panel requires
  unanimity. Trade-off: live-tip behavior of this method is not measured.
- **Two buckets, one per detail level.** `signatures` (limit 1000) hashes
  `{ signature, slot, err }` per entry; `full` (limit 25, json encoding)
  hashes `{ signature, slot, err, fee, preBalances, postBalances }` per
  transaction — the same canonical slice as `getTransaction`. Both drop the
  provider-internal `paginationToken`, `blockTime`, `memo`,
  `confirmationStatus`, `transactionIndex`, and (full mode) the message body,
  logs, and `version`. Params stick to the cross-provider common subset: no
  Helius-only `tokenTransfer` filter, no `processed` commitment, full-mode
  limit under Alchemy's cap.

Challenge addresses are transaction signers harvested from a block probed
*below* the pin (guaranteeing at least one transaction inside the filter
window), filtered to non-high-activity addresses. That filter is load-bearing
here: high-activity addresses (programs, vote authorities) diverge across
providers' indexers (vote-transaction indexing differs), and excluding them is
what makes byte-equal consensus possible.

## Test ages & archival depth

Most tests draw from live, recent chain state (the last seconds to hours). The
methods whose answers are immutable history — `getBlock`, `getTransaction`,
`getBlockTime`, `getBlocks`, `getBlocksWithLimit`, `getBlockCommitment`, and
`getSignaturesForAddress` — also carry an **archival** bucket that samples a
uniform-random slot **182–365 epochs back (≈1–2 years)**. That depth sits well
past every provider's recent-ledger retention and warm storage, so archival
buckets measure real archive reads (cold deep-history lookups), not caches.
Every archival input is freshly drawn per test — nothing is reused, so
providers can't pre-warm the answers.

Two archival-specific rules:

- **Frozen signature windows are byte-equal.** The `getSignaturesForAddress`
  archival bucket pins its query strictly `before` a 1–2-year-old anchor
  signature, making the expected result immutable. Consensus there is strict
  byte-equality — any divergence is a real archive gap, so the similarity
  tolerance used for tip-anchored windows doesn't apply.
- **Archival calls get a 10s client budget** instead of the 5s default, since
  cold archive reads are slower. Latency comparisons are always within-bucket,
  so this doesn't skew any cross-bucket numbers, and a timeout still counts
  against Reliability.

Methods whose deep history isn't reliably served by validators (leader
schedules: `getSlotLeaders`, `getLeaderSchedule`) deliberately have no archival
bucket, and account-state methods can't have one — Solana RPC has no
point-in-time account reads.

## Latency & freshness

- **Cold**: time to first byte starting from just before the socket connects
  (includes the TLS/TCP handshake). This is the worst case, like the first call
  from a fresh pod.
- **Warm**: time to first byte over a kept-open HTTP/2 connection. This is the
  best case, like a steady, busy workload.

Freshness is measured on a separate connection so it never adds time to the
latency we report.

## Verification

Every test has a public page at `/raw?challenge=<id>`: the inputs, the commitment
hash, the revealed seed, each provider's response, the consensus result, and the
independent reference's verdict. You can recompute the hash yourself and confirm
the inputs were fixed before anyone answered: commitment = SHA-256(seed ‖
canonical-JSON(params)), where canonical-JSON recursively sorts object keys —
the same canonicalization used for projection hashing. (Challenges generated
before the canonical-serialization change hashed insertion-order JSON instead;
recompute those with `JSON.stringify(params)` as stored.) When the scoring or
comparison rules change, we bump the methodology version so past results stay
coherent.

The independent reference's full response payload is shown for the first 6 hours
after a test is generated, then trimmed to bound storage; its canonical
reference hash — what the verdict is computed against — is retained permanently,
so the audit verdict on any test stays verifiable indefinitely.

## Anti-gaming defenses

A provider that can recognize benchmark traffic can serve it from a fast path
and look better than it is. The defenses, all verifiable in this repo:

- **Commit-reveal with a 30-second TTL.** Test parameters are derived from
  live on-chain state and their hash is locked in before any request is sent;
  the seed is revealed after the test expires. Providers can't precompute
  answers, and the operator can't cherry-pick favorable tests after the fact.
  The short TTL means pre-warming a cache for a specific test is useless.
- **Honeypots.** About 5% of tests are pre-validated probes with known
  answers, drawn least-recently-used from a per-method pool. They are
  indistinguishable from fresh tests (workers read a view that hides the
  honeypot flag, and the request shape is identical). Appearing on the
  leaderboard requires a ≥95% honeypot pass rate (Wilson lower bound) — a
  provider that special-cases benchmark traffic and gets honeypots wrong
  drops off the board.
- **Vantage and egress diversity.** The same tests are fired from multiple
  clouds and egress paths, and every sample is tagged with its egress path —
  a provider allow-listing or special-casing known benchmark IPs shows up as
  a per-egress discrepancy.
- **Auditor tripwire and finality re-verification.** Consensus is
  cross-checked against an independent reference at test time (§ Consensus
  decision rules) and re-verified against finalized chain state afterward
  (§ Deferred finality re-verification).
- **Disclosed limitations.** Where a provider's tier can't support a defense
  (for example, a key embedded in the URL that can't be rotated), that is
  surfaced as a caveat badge on the leaderboard rather than silently ignored.
  The defense model does not rely on key rotation.

## Operator vs reproducer cost

Every provider on the panel is measured symmetrically — same challenges, same
timeouts, same scoring. The only asymmetry is who pays for the traffic: the
operator's own provider traffic is internal ($0 at any tier), while a
third-party reproducer needs paid tiers on every benchmarked provider to
sustain the shared cadence (for example, the public Helius free tier's ~1M
credits/mo cap is far below benchmark volume). This affects the cost of
*reproducing* the benchmark, not the measurements themselves — anyone can run
the same code against their own keys and recompute every score.

## POC status

This is an early deployment, so the qualification thresholds above are looser than
our long-term targets while sample volume builds up. Workers currently run on AWS,
TeraSwitch, Cloudflare, and GCP (with Latitude staged), the generator runs
active + hot-standby, and the panel is Helius, Triton, Alchemy, and QuickNode.
Honeypot tests (pre-seeded known answers) are active and gate leaderboard
eligibility. Endpoint cycling was removed — each provider runs a single
endpoint; it would only return if a provider publishes confirmed-equivalent
alternate endpoints.
