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

We never trust one provider to tell us the "right" answer. Every provider gets
the same request, and we go with the answer **most of them agree on**. Match the
majority and you're marked correct; be the odd one out and you're marked wrong.

We only score a test when the outcome is clear. Cold and warm requests are judged
separately:

| What happened | Result |
|---|---|
| Fewer than 3 providers returned a usable answer | Skipped — not enough to compare |
| No clear majority (e.g. a 2–2 tie) | Skipped — too close to call |
| A clear majority agrees | That group is **correct**; anyone who disagrees is **wrong** |

**Who votes.** The panel is **Helius, Triton, Alchemy, and QuickNode** — four
providers on most methods. If a provider's plan simply doesn't offer a method, it
isn't counted for or against on that method. That's a known limitation, not a
failure.

Two methods have only three voters, because QuickNode either doesn't offer them
or returns the result in a different shape we can't compare against the others:

- `simulateBundle`
- `getTransactionsForAddress`

On these three-voter methods, two providers agreeing is enough to settle the
answer (the third is then the odd one out and scored wrong). We still need all
three to answer for the test to count.

**A second opinion.** Every test also has a reference answer from an independent
source, fetched the moment the test is created. If the majority disagrees with
that reference, we throw the whole test out — a safeguard for the rare case where
the majority itself is wrong.

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

`getTransactionsForAddress` is the benchmark's first non-standard method — an
indexer-backed address-history API served by Helius, Triton, and Alchemy
(QuickNode's variant is non-comparable; see the consensus section). Two things
differ from its standard sibling `getSignaturesForAddress`:

- **Slot-pinned, byte-equal.** Every test pins the query to `slot ≤ tip − 5000`
  (~35 minutes back, deeply finalized), newest-first. That makes the answer
  immutable — the tip drift that forces `getSignaturesForAddress` into fuzzy
  matching is excluded — so both buckets match **byte-for-byte**, as the
  3-voter panel requires. Trade-off: live-tip behavior isn't measured.
- **Two detail levels.** `signatures` (limit 1000) hashes
  `{ signature, slot, err }` per entry; `full` (limit 25) hashes the same
  canonical slice as `getTransaction`
  (`{ signature, slot, err, fee, preBalances, postBalances }`). Both drop
  provider-internal fields (`paginationToken`, `blockTime`, `memo`, …), and
  params stay in the cross-provider common subset (no Helius-only filters, no
  `processed` commitment, limit under Alchemy's cap).

Test addresses are signers pulled from a block just below the pin (guaranteeing
a transaction in range), restricted to **non-high-activity** addresses —
programs and vote authorities index differently across providers, so excluding
them is what makes byte-equal agreement possible.

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

Every test has a public page at `/raw?challenge=<id>`: the inputs, commitment
hash, revealed seed, each provider's response, the consensus result, and the
reference's verdict. To confirm the inputs were fixed before anyone answered,
recompute `commitment = SHA-256(seed ‖ canonical-JSON(params))` yourself
(canonical-JSON sorts object keys recursively — the same canonicalization used
for projection hashing). When the scoring rules change, we bump the methodology
version so past results stay coherent.

The reference's full response is shown for the first 6 hours, then trimmed to
save storage; its reference hash — what the verdict is checked against — is kept
permanently, so any test's verdict stays verifiable indefinitely.

## Anti-gaming defenses

A provider that can recognize benchmark traffic could serve it from a fast path
and look better than it is. The defenses, all verifiable in this repo:

- **Commit-reveal (30-second TTL).** Test parameters come from live on-chain
  state and their hash is locked in before any request is sent; the seed is
  revealed after the test expires. So providers can't precompute answers, the
  operator can't cherry-pick favorable tests, and the short TTL makes
  pre-warming a cache useless.
- **Honeypots.** About 5% of tests are pre-validated probes with known answers,
  indistinguishable from real ones (workers can't see the honeypot flag; the
  request looks identical). Making the leaderboard requires a ≥95% honeypot pass
  rate (Wilson lower bound), so a provider that special-cases benchmark traffic
  and fails them drops off.
- **Vantage and egress diversity.** The same tests are fired from multiple
  clouds and egress paths, and each sample is tagged with its path. Allow-listing
  or special-casing benchmark IPs then shows up as a per-egress discrepancy.
- **Auditor and finality checks.** Consensus is cross-checked against an
  independent reference at test time ([consensus rules](#consensus-decision-rules))
  and re-verified against finalized chain state afterward
  ([deferred finality re-verification](#deferred-finality-re-verification)).
- **Disclosed limitations.** Where a provider's tier can't support a defense
  (e.g. a key embedded in the URL that can't be rotated), it's shown as a caveat
  badge rather than silently ignored. The model doesn't rely on key rotation.

## Cost of reproducing

Every provider is measured the same way: same challenges, same timeouts, same
scoring. The one difference is cost. The operator runs its own provider for
free, but anyone reproducing the benchmark needs a **paid tier on every
provider**. Free tiers can't keep up with the benchmark's volume (the Helius
free tier's ~1M credits/month, for instance, is far below it), so running on
free tiers won't give the same or accurate results. This only changes what it
costs to reproduce the benchmark, not the measurements. Anyone can run the same
code against their own keys and recompute every score.
