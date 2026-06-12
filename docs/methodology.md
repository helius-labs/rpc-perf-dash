# Methodology

This page explains how the benchmark works: how we choose what to test, how we
decide which answer is right, and how the score is built. The short version is
right below; open any section for the details.

## In short

- **What it measures.** For each provider, in each region, on each RPC method:
  how fast it responds (p50/p95), how often it's the fastest *correct* answer
  (win rate), how reliable it is, and whether its data is right, combined into
  one score.
- **Why you can trust it.** Every test query is drawn from live on-chain data and
  locked in (hashed) *before* any provider answers, then revealed afterward, so
  nobody can precompute answers or cherry-pick results. Tests expire after 30
  seconds.
- **Where it runs.** We send the same requests from several cloud regions at once.
  The leaderboard blends regions, leaning on NA-East and EU-Central (our two
  best-covered). You can filter by region on the Performance page.
- **How it's scored.** `0.25·Latency + 0.25·Win-rate + 0.25·Reliability +
  0.20·Correctness + 0.05·Freshness`. Re-weight it for your workload with the
  presets on the Overview.
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
| No group of 3 or more agrees (`g < 3`) | **Ambiguous**: thrown out |
| The largest group isn't a clear majority (e.g. a 2–2 tie) | **Ambiguous**: thrown out |
| A group of 3+ forms a clear majority | That group is **correct**; everyone outside it is a **dissenter** |

The voting panel is **Helius, Triton, Alchemy, and QuickNode**: four voters on
every method.

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

### Region weights

The "Overall" view blends regions with these default weights:

| Region | Weight |
|---|---|
| NA East | 0.35 |
| EU Central | 0.35 |
| AP Northeast | 0.20 |
| NA West | 0.10 |

For each provider the weights are re-normalized over only the regions where it
qualifies, so a provider that isn't in a region isn't penalized for it.

### Who qualifies

To appear ranked, a provider needs enough data to be meaningful: currently a 4h
window, at least 50 samples per (provider × method × region), ≥80% reliability,
≥80% correctness, and a ≥95% honeypot pass rate (Wilson lower bound). Below
that, it shows with a "below thresholds" note.

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
