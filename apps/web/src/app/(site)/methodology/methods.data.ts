/**
 * Per-method reference data for the methodology page's Method Explorer.
 *
 * This is hand-authored from the actual handler code (packages/methods/src/*,
 * packages/shared/src/consensus.ts) — NOT from prose — so it stays the precise,
 * code-true description of how each challenge's input is generated and how its
 * correctness is verified. When a handler's bucket set, projection, or match
 * predicate changes, update the matching entry here (and docs/methodology.md).
 *
 * 45 methods are emitted by the generator's `allMethodBucketCombos`
 * (apps/generator/src/index.ts), plus three implemented-but-dormant methods
 * (getSupply, getClusterNodes, getLargestAccounts) that can't reach
 * cross-provider consensus on the current panel.
 */

export type TechniqueKey =
  | "byte-equal"
  | "jaccard"
  | "tolerance"
  | "value-tolerance"
  | "well-formed"
  | "hybrid";

export interface TechniqueMeta {
  /** Sidebar group header + detail-pane pill label. */
  label: string;
  /** One-line description of the family, shown under the group header. */
  blurb: string;
  /** Accent color for the dot / pill / active rail. */
  color: string;
}

export const TECHNIQUES: Record<TechniqueKey, TechniqueMeta> = {
  "byte-equal": {
    label: "Byte-equal hash",
    blurb: "A canonical projection is hashed; the bytes must match exactly.",
    color: "#6fb3ff",
  },
  jaccard: {
    label: "Set similarity",
    blurb: "Answers are sets; they agree when their Jaccard overlap clears a threshold.",
    color: "#c08cff",
  },
  tolerance: {
    label: "Slot tolerance",
    blurb: "A constantly-advancing slot; tips within a slot window are treated as equal.",
    color: "#56cbb0",
  },
  "value-tolerance": {
    label: "Value tolerance",
    blurb: "A monotonic counter (height / tx count); values within a numeric window are treated as equal.",
    color: "#56b0cb",
  },
  "well-formed": {
    label: "Well-formedness",
    blurb: "A node-specific value that can't be cross-compared; scored on availability + a well-formedness gate only.",
    color: "#9aa0a6",
  },
  hybrid: {
    label: "Value-or-fresh",
    blurb: "Byte-equal on the value when the panel agrees; a freshness fallback when it churns.",
    color: "#f0a868",
  },
};

export interface MethodInput {
  /** What single value is randomly drawn per challenge. */
  draws: string;
  /** Where that value comes from (the on-chain pool / request itself). */
  from: string;
  /** Bucket count + the dimensions that compose them. */
  buckets: string;
  /** Commitment level (and why, when notable). */
  commitment?: string;
  /** Any request-shape perturbation applied per call. */
  perturbation?: string;
}

export interface MethodSpec {
  name: string;
  technique: TechniqueKey;
  /** Short, exact restatement of the match rule for the pill subtitle. */
  techniqueDetail: string;
  /** One-line "what kind of answer is this" framing. */
  shape: string;
  input: MethodInput;
  projection: { keeps: string; drops: string };
  /** Full prose of how correctness is decided. */
  match: string;
  /** Voter line. */
  voters: string;
  /** Caveats worth surfacing inline. */
  notes?: string[];
  /** Implemented but not emitted by the generator. */
  dormant?: boolean;
}

const PANEL = "5 voters · Helius, Triton, Alchemy, QuickNode, Chainstack";

export const METHODS: readonly MethodSpec[] = [
  // ---- Byte-equal hash --------------------------------------------------
  {
    name: "getBlock",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Immutable block (read at confirmed)",
    input: {
      draws: "A specific slot",
      from: "the generator's live recent-slot window; archival buckets reach back 182–365 epochs (tip−78.6M…157.7M slots, ≈1–2 years — true archive depth, not warm storage)",
      buckets:
        "8: slot-age (tip−5 / last hour / last 24h / archival) × tx-count band (high ≥1500 / low)",
      commitment:
        "confirmed for every bucket: finalization is a ~13s network-wide timer identical for all providers, so it measures nothing; confirmed propagates in ~2s where providers actually diverge",
      perturbation:
        "transactionDetails randomized full ↔ accounts per call (projection-invariant, but defeats byte-equal request caching)",
    },
    projection: {
      keeps:
        "blockhash, parentSlot, previousBlockhash, and a per-tx record (sorted signatures + meta err/fee/pre & postBalances); the tx list is sorted by first signature",
      drops: "blockTime, rewards, logMessages, innerInstructions, loadedAddresses",
    },
    match:
      "Byte-equal on the projection hash. A hash match at a tip more than 2 slots behind the reference (≥3) scores stale; any other mismatch scores incorrect.",
    voters: PANEL,
    notes: [
      "The per-tx err is normalized before hashing — the InstructionError BorshIoError variant collapses to its unit form ({\"BorshIoError\":\"…\"} → \"BorshIoError\") — so a validator-version serialization skew (one tx per block) isn't a false mismatch. Other error variants (e.g. Custom) compare as-is.",
    ],
  },
  {
    name: "getTransaction",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Immutable transaction (finalized)",
    input: {
      draws: "A specific transaction signature",
      from: "a probed block at the bucket's age (recent <1h, or archival 182–365 epochs back ≈1–2 years)",
      buckets:
        "16: size (small ≤2 ix / large ≥10) × complexity (simple / program-heavy ≥3 programs) × version (legacy / v0) × age (recent / archival)",
      commitment: "finalized",
    },
    projection: {
      keeps:
        "found flag, slot, tx version, sorted signatures, and meta err/fee/pre & postBalances",
      drops: "blockTime, logMessages, innerInstructions, loadedAddresses",
    },
    match:
      "Byte-equal hash. If the reference found the tx but a provider returned null → incomplete; other mismatches → incorrect; a match more than 2 slots behind (≥3) → stale.",
    voters: PANEL,
    notes: [
      "The meta err is normalized before hashing — the InstructionError BorshIoError variant collapses to its unit form — so a validator-version serialization skew isn't a false mismatch.",
    ],
  },
  {
    name: "getAccountInfo",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal hash, structural-only",
    shape: "Mutable account · structural slice",
    input: {
      draws: "An account pubkey",
      from: "account keys in a probed recent block, filtered by account type",
      buckets: "5: wallet / token-account / mint / program / nonexistent",
      commitment: "finalized",
    },
    projection: {
      keeps:
        "{ exists, owner, executable, space, dataPrefix }, where dataPrefix is an account-type-aware structural slice (token: [0,64); mint: [0,36)+[44,82))",
      drops: "lamports and every mutable balance byte",
    },
    match:
      "Byte-equal on the structural hash. A match → correct; a provider returning null where the reference exists → incomplete. Any other mismatch is judged by each response's own context.slot vs the majority's freshest read: strictly newer → excluded as fresher-than-panel (no-fault, neither correct nor incorrect), same slot → incorrect, older → stale.",
    voters: PANEL,
    notes: [
      "Structural-only by design: it verifies the right account with the right owner & layout, not its (mutable) balance.",
    ],
  },
  {
    name: "getProgramAccounts",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal hash, structural-only",
    shape: "Mutable account set · structural slice",
    input: {
      draws: "An anchor: a token mint/owner, or a validator vote account",
      from: "mints / signers / vote accounts in a probed recent block, queried against the SPL Token, Token-2022, and Stake programs",
      buckets: "10: SPL Token & Token-2022 (by-mint / by-owner) + Stake (by-voter), each × size band (small 1–20 / medium 21–200)",
      commitment: "finalized; server-side dataSlice over the immutable prefix ([0,64) mint+owner for tokens; [0,156) for stake)",
    },
    projection: {
      keeps: "sorted set of { pubkey, owner, dataPrefix } where dataPrefix is the server-side immutable slice",
      drops: "mutable bytes dropped server-side (token amount [64,72); stake amount / epochs / credits [156,200)); set capped at 200 accounts",
    },
    match:
      "Byte-equal hash. A match → correct; on a mismatch, a provider at a newer observed tip → stale, else incorrect. (Its response is a bare array with no context.slot, so — unlike the sibling account methods — it uses the observed-tip fallback rather than per-response slot adjudication.)",
    voters: PANEL,
    notes: [
      "The panel itself is the reference, so enumeration methods get full correctness scoring via majority consensus across the panel.",
      "Classic SPL Token is filtered to the 165-byte base size; Token-2022 gets no dataSize filter (its extension accounts run larger than 165 bytes and are deliberately included). Cross-provider comparability comes from the memcmp anchor plus the [0,64) mint+owner slice, not from size-filtering.",
      "Stake is anchored by a validator vote account; the [0,156) slice keeps the authorities + delegated voter and drops the mutable stake amount, activation/deactivation epochs, and credits.",
    ],
  },
  {
    name: "getTokenAccountsByOwner",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal hash, structural-only",
    shape: "Mutable account set · structural slice",
    input: {
      draws: "An owner (or owner + mint)",
      from: "signers in a probed recent block",
      buckets: "3: by-program (few 1–20 / many 21–200) / by-mint (single)",
      commitment: "finalized; native JSON-RPC (not the Helius DAS variant); same 64-byte dataSlice",
    },
    projection: {
      keeps: "sorted set of { pubkey, owner, dataPrefix } (same 64-byte structural slice)",
      drops: "the mutable amount bytes; set capped at 200 accounts",
    },
    match:
      "Byte-equal hash. A match → correct; on a mismatch the divergence is judged by each response's own context.slot vs the majority's freshest read — strictly newer → excluded as fresher-than-panel (no-fault), same slot → incorrect, older → stale.",
    voters: PANEL,
    notes: [
      "Providers historically return divergent / incomplete token-account sets, so expect an elevated no-consensus rate on this method specifically.",
    ],
  },

  // ---- Set similarity (Jaccard) ----------------------------------------
  {
    name: "getSignaturesForAddress",
    technique: "jaccard",
    techniqueDetail: "Tip-anchored Jaccard ≥ 0.8",
    shape: "Append-only signature log",
    input: {
      draws: "A signer address",
      from: "transaction signers in a probed recent block, classified by activity — or, for the archival bucket, a signer + anchor signature harvested from a block 182–365 epochs (≈1–2 years) back",
      buckets:
        "7: activity (medium / low; high is pruned for cross-camp tip drift) × address type (program / token-account / user-wallet) with latest cursor, limit 1000 — plus 1 archival frozen window (limit 100, pinned strictly before a 1–2-year-old anchor signature)",
      commitment: "finalized",
    },
    projection: {
      keeps:
        "set of { signature, slot, err, confirmationStatus }, sorted by signature, after dropping the newest 20% by slot (err normalized: BorshIoError → unit form)",
      drops: "blockTime, memo, and the freshest 20% of entries before hashing",
    },
    match:
      "Fast path byte-equal; else tip-anchored Jaccard ≥ 0.8: sigs newer than min(maxSlot) − 32 (~13s) are dropped first, so the panel's two 'finalized' camps ({Helius, Triton} vs {Alchemy, QuickNode}) compare on a window everyone has settled. Falls back to full-set Jaccard when the trim leaves <3 sigs. The archival frozen window is strict byte-equal — everything before the anchor is immutable, so any divergence is a real archive gap (Jaccard tolerance would mask a provider missing up to 15% of deep history).",
    voters: PANEL,
    notes: [
      "An empty list (e.g. a provider past its retention horizon) abstains rather than dissenting, so it can't force a no-consensus.",
      "Archival-bucket calls (here and on the other archival methods) run under a 10s client timeout instead of the 5s default — cold archive reads are slower; latency comparisons stay within-bucket, and timeouts still count against Reliability.",
    ],
  },
  {
    name: "getTokenLargestAccounts",
    technique: "jaccard",
    techniqueDetail: "Jaccard ≥ 0.75",
    shape: "Top-holder set",
    input: {
      draws: "A mint",
      from: "a token account of a recent signer (≥3 holders required)",
      buckets: "1: mint",
      commitment: "finalized",
    },
    projection: {
      keeps: "the set of the top-20 holder addresses by amount (capped from the up-to-100 some providers return)",
      drops: "all balances / amounts: amounts only rank the top-20, then just the addresses are kept",
    },
    match:
      "Fast path byte-equal; else Jaccard ≥ 0.75 over the holder-address set, which tolerates ~2–3 rank-boundary swaps on the 20-element list.",
    voters:
      "4 voters · Helius, Triton, Alchemy, QuickNode (Chainstack returns \"only available on dedicated nodes\" for getTokenLargestAccounts → tier_method_unsupported)",
    notes: [
      "The spec returns the 20 largest holders, but some providers (QuickNode) return up to 100; the projection caps to the top-20 by amount before comparison, so a longer list is not a false mismatch.",
      "Chainstack's shared/free tier restricts this to dedicated nodes only (confirmed live, -32601); dropped from the panel as unsupported, not penalized.",
    ],
  },

  // ---- Slot tolerance ---------------------------------------------------
  {
    name: "getSlot",
    technique: "tolerance",
    techniqueDetail: "Slot tolerance ≤ 4",
    shape: "Advancing scalar · chain tip",
    input: {
      draws: "A commitment level",
      from: "the request itself (no on-chain parameter)",
      buckets: "3: processed / confirmed / finalized",
    },
    projection: {
      keeps: "{ slot }",
      drops: "—",
    },
    match:
      "Slot tolerance ≤ 4 (~1.6s) for consensus. A constantly-advancing integer can never hash-match, so correctness is a liveness check by construction (C ≈ 100%).",
    voters: PANEL,
    notes: [
      "Primarily a latency / reliability probe: its correctness axis is a liveness check, not a data-equality check.",
    ],
  },
  {
    name: "getLatestBlockhash",
    technique: "tolerance",
    techniqueDetail: "Slot tolerance ≤ 4 + well-formedness gate",
    shape: "Advancing scalar · recent blockhash",
    input: {
      draws: "A commitment level",
      from: "the request itself (no on-chain parameter)",
      buckets: "2: finalized / confirmed",
    },
    projection: {
      keeps: "{ slot }; blockhash + lastValidBlockHeight carried for the gate",
      drops: "the blockhash value is never compared across providers",
    },
    match:
      "Slot tolerance ≤ 4 (consensus), plus a local gate: blockhash must be base58-32 and lastValidBlockHeight finite & >0. The blockhash value itself is never cross-checked.",
    voters: PANEL,
    notes: [
      "No cross-provider validation of the blockhash value. Correctness is freshness + a well-formedness gate only; same honest limitation as getSlot.",
    ],
  },

  // ---- Hybrid value-or-fresh -------------------------------------------
  {
    name: "getBalance",
    technique: "hybrid",
    techniqueDetail: "Hybrid value-or-fresh",
    shape: "Mutable scalar · lamports",
    input: {
      draws: "A wallet pubkey",
      from: "signers in a probed recent block",
      buckets: "2: wallet / nonexistent",
      commitment: "finalized",
    },
    projection: {
      keeps: "{ lamports } (value only); context.slot carried for freshness",
      drops: "everything but the lamports value",
    },
    match:
      "Byte-equal on lamports: a ≥3-voter value-majority verifies the balance; a dissenter is judged by context.slot vs the majority's freshest read — strictly newer → excluded as fresher-than-panel (no-fault; a faster node that already saw the next update isn't wrong), same slot → incorrect, older → stale. If ≥3 voters return but no value-majority forms (the account churned in-window), the runner falls back to a freshness verdict on context.slot (logged as liveness_fallback, distinct from ambiguous).",
    voters: PANEL,
  },
  {
    name: "getTokenSupply",
    technique: "hybrid",
    techniqueDetail: "Hybrid value-or-fresh",
    shape: "Mutable scalar · token supply",
    input: {
      draws: "A mint",
      from: "a token account of a recent signer",
      buckets: "1: mint",
      commitment: "finalized",
    },
    projection: {
      keeps: "{ amount, decimals }",
      drops: "float uiAmount / uiAmountString",
    },
    match:
      "Same hybrid path as getBalance: a value-majority verifies the supply, else the runner falls back to a liveness verdict.",
    voters: PANEL,
  },
  {
    name: "getTokenAccountBalance",
    technique: "hybrid",
    techniqueDetail: "Hybrid value-or-fresh",
    shape: "Mutable scalar · token balance",
    input: {
      draws: "A token account",
      from: "a token account drawn from recent on-chain state",
      buckets: "1: token-account",
      commitment: "finalized",
    },
    projection: {
      keeps: "{ amount, decimals }",
      drops: "float uiAmount / uiAmountString",
    },
    match: "Same hybrid path as getBalance: value-majority verifies the balance, else a liveness fallback.",
    voters: PANEL,
  },

  // ---- Dormant ----------------------------------------------------------
  {
    name: "getSupply",
    technique: "tolerance",
    techniqueDetail: "Implemented but not emitted",
    shape: "Full-supply scan (dormant)",
    dormant: true,
    input: {
      draws: "A full-supply scan (no parameter)",
      from: "—",
      buckets: "not emitted",
    },
    projection: {
      keeps:
        "{ slot } for grouping; total / circulating / nonCirculating carried for an internal consistency gate (circulating + nonCirculating ≈ total), then a freshness verdict on slot — like getSlot, not a value-majority hybrid",
      drops: "n/a (handler registered but the generator never dispatches it)",
    },
    match:
      "Cannot reach a 3-voter consensus on the current panel at any timeout: only Triton (~6s) and Alchemy (~9s) compute it live and agree, QuickNode serves a stale cache, Helius hangs >30s. The handler stays registered (dormant) so any in-flight straggler resolves safely; re-enabling is a one-line add to allMethodBucketCombos.",
    voters: "—",
  },

  // ---- A · deterministic byte-equal (pinned to finalized data) ---------
  {
    name: "getGenesisHash",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Network constant · genesis hash",
    input: { draws: "Nothing", from: "the request itself (no parameter)", buckets: "1: default" },
    projection: { keeps: "{ genesisHash }", drops: "—" },
    match: "Byte-equal. Identical for every mainnet node forever; any divergence is a forked/wrong node.",
    voters: PANEL,
  },
  {
    name: "getEpochSchedule",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Network constant · epoch schedule",
    input: { draws: "Nothing", from: "the request itself (no parameter)", buckets: "1: default" },
    projection: {
      keeps: "{ slotsPerEpoch, leaderScheduleSlotOffset, warmup, firstNormalEpoch, firstNormalSlot }",
      drops: "—",
    },
    match: "Byte-equal: a genesis-config constant.",
    voters: PANEL,
  },
  {
    name: "getInflationGovernor",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Governance constant · inflation params",
    input: { draws: "Nothing", from: "the request itself (no parameter)", buckets: "1: default" },
    projection: { keeps: "{ initial, terminal, taper, foundation, foundationTerm }", drops: "—" },
    match: "Byte-equal: protocol parameters that change only by governance.",
    voters: PANEL,
  },
  {
    name: "getInflationRate",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Per-epoch deterministic rate",
    input: { draws: "Nothing", from: "the request itself (no parameter)", buckets: "1: default" },
    projection: { keeps: "{ epoch, total, validator, foundation }", drops: "—" },
    match: "Byte-equal. Deterministic from the inflation curve per epoch; an epoch-boundary straddle → ambiguous (dropped, rare).",
    voters: PANEL,
  },
  {
    name: "getBlockTime",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Immutable block timestamp",
    input: {
      draws: "A finalized slot",
      from: "the recent-slot window (recent_finalized tip−150..9000, or archival 182–365 epochs ≈1–2 years back); probed to confirm the slot was produced",
      buckets: "2: recent_finalized / archival",
    },
    projection: { keeps: "{ blockTime }", drops: "—" },
    match: "Byte-equal. The production time of a finalized slot is fixed.",
    voters: PANEL,
  },
  {
    name: "getBlockCommitment",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Settled commitment + total stake",
    input: {
      draws: "A finalized slot",
      from: "the recent-slot window (recent_finalized) / 182–365 epochs ≈1–2 years back (archival)",
      buckets: "2: recent_finalized / archival",
    },
    projection: {
      keeps: "{ totalStake (rounded to 1e3 lamports), commitmentNull }",
      drops: "the precise float64 noise on the u64 totalStake",
    },
    match: "Byte-equal. Finalized commitment has settled (null) and totalStake is stable within an epoch.",
    voters: PANEL,
  },
  {
    name: "getBlocks",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Immutable produced-slot set",
    input: {
      draws: "A finalized start slot",
      from: "the recent-slot window (recent_finalized) / 182–365 epochs ≈1–2 years back (archival); window is a fixed 20-slot span [start, start+20]",
      buckets: "2: recent_finalized / archival",
    },
    projection: { keeps: "sorted set of produced slots in range", drops: "—" },
    match: "Byte-equal. The produced-slot set over a finalized range is immutable.",
    voters: PANEL,
  },
  {
    name: "getInflationReward",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Completed-epoch reward",
    input: {
      draws: "5 vote-account pubkeys + the previous epoch",
      from: "the utility endpoint's getVoteAccounts (current set) and getEpochInfo (epoch−1)",
      buckets: "1: prev_epoch",
    },
    projection: {
      keeps: "per-address { epoch, amount, effectiveSlot, commission } in request order",
      drops: "postBalance",
    },
    match: "Byte-equal. A completed epoch's reward is immutable (null for an unrewarded account is itself deterministic).",
    voters: PANEL,
  },
  {
    name: "getLeaderSchedule",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Per-epoch leader schedule",
    input: {
      draws: "A slot pinning the current epoch (tip−1000)",
      from: "the recent-slot window",
      buckets: "1: current_epoch",
    },
    projection: { keeps: "the full validator → leader-slot-indices map", drops: "—" },
    match: "Byte-equal. Fixed at epoch start; pinning a concrete slot makes every provider resolve the same epoch.",
    voters: PANEL,
  },
  {
    name: "getBlockProduction",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Completed-range production stats",
    input: {
      draws: "A finalized slot range",
      from: "tip−200 back 1000 slots (a completed, immutable window)",
      buckets: "1: recent_range",
    },
    projection: { keeps: "per-validator { leaderSlots, blocksProduced } map + range", drops: "—" },
    match: "Byte-equal. Production counts over a finalized range are immutable.",
    voters: PANEL,
  },

  // ---- B1 · tip-slot freshness -----------------------------------------
  {
    name: "getMaxRetransmitSlot",
    technique: "tolerance",
    techniqueDetail: "Slot tolerance ≤ 4",
    shape: "Node-local advancing slot",
    input: { draws: "Nothing", from: "the request itself (no parameter)", buckets: "1: default" },
    projection: { keeps: "{ slot }", drops: "—" },
    match: "Slot tolerance ≤ 4 (consensus), like getSlot; correctness is a freshness verdict.",
    voters: PANEL,
  },
  {
    name: "getMaxShredInsertSlot",
    technique: "tolerance",
    techniqueDetail: "Slot tolerance ≤ 4",
    shape: "Node-local advancing slot",
    input: { draws: "Nothing", from: "the request itself (no parameter)", buckets: "1: default" },
    projection: { keeps: "{ slot }", drops: "—" },
    match: "Slot tolerance ≤ 4 (consensus); correctness is a freshness verdict.",
    voters: PANEL,
  },
  {
    name: "getEpochInfo",
    technique: "tolerance",
    techniqueDetail: "Epoch-equal + slot tolerance ≤ 4",
    shape: "Advancing epoch + absolute slot",
    input: {
      draws: "A commitment level",
      from: "the request itself (no on-chain parameter)",
      buckets: "3: processed / confirmed / finalized",
    },
    projection: { keeps: "{ epoch, slot: absoluteSlot }", drops: "slotIndex, blockHeight, transactionCount" },
    match:
      "epoch must match AND absoluteSlot within ≤ 4 (consensus). A plain slot tolerance would wrongly match across an epoch rollover, so the predicate is epoch-gated; correctness is a freshness verdict on absoluteSlot.",
    voters: PANEL,
  },

  // ---- B2 · value-tolerance scalars ------------------------------------
  {
    name: "getBlockHeight",
    technique: "value-tolerance",
    techniqueDetail: "Value tolerance ≤ 4",
    shape: "Monotonic counter · block height",
    input: {
      draws: "A commitment level",
      from: "the request itself (no on-chain parameter)",
      buckets: "3: processed / confirmed / finalized",
    },
    projection: { keeps: "{ value: blockHeight }", drops: "—" },
    match:
      "Value tolerance ≤ 4 blocks (consensus). Block height is NOT a slot (it skips empty slots), so it can't reuse the slot predicate; correctness compares the provider's height to the consensus value (monotonic: at-or-ahead → correct, behind by >tol → stale).",
    voters: PANEL,
  },
  {
    name: "getTransactionCount",
    technique: "value-tolerance",
    techniqueDetail: "Value tolerance (tuned)",
    shape: "Monotonic counter · tx count",
    input: {
      draws: "A commitment level",
      from: "the request itself (no on-chain parameter)",
      buckets: "3: processed / confirmed / finalized",
    },
    projection: { keeps: "{ value: transactionCount }", drops: "—" },
    match:
      "Value tolerance compared like getBlockHeight, but with a much wider window (~thousands tx/s). The tolerance is an INITIAL estimate pending live tuning against the measured inter-provider spread.",
    voters: PANEL,
    notes: [
      "Tolerance constants are unmeasured estimates pending live tuning, so read the correctness number only after tuning.",
    ],
  },

  // ---- C · set similarity (Jaccard) ------------------------------------
  {
    name: "getVoteAccounts",
    technique: "jaccard",
    techniqueDetail: "Jaccard ≥ 0.95",
    shape: "Validator vote-account set",
    input: {
      draws: "Nothing",
      from: "the request itself: { commitment, keepUnstakedDelinquents:false }",
      buckets: "1: default",
    },
    projection: { keeps: "the set of vote pubkeys (current ∪ delinquent)", drops: "stake, lastVote, and all mutable per-account fields" },
    match: "Jaccard ≥ 0.95 over the vote-pubkey set. The active validator set barely changes within a window.",
    voters: PANEL,
  },
  {
    name: "getRecentPerformanceSamples",
    technique: "well-formed",
    techniqueDetail: "Well-formedness gate (availability)",
    shape: "Per-slot performance window",
    input: { draws: "A sample count (30)", from: "the request itself", buckets: "1: default" },
    projection: {
      keeps: "{ wellFormed }: ≥1 samples, each with finite slot/numTransactions/numSlots/samplePeriodSecs",
      drops: "the sample values themselves (not cross-compared)",
    },
    match:
      "Boolean well-formedness, byte-equal. Live validation showed providers sample at DISJOINT slots (~60s apart, zero overlap), so a Jaccard-on-slots never converges; this measures availability + structure instead.",
    voters: PANEL,
    notes: ["Providers sample at their own slots, so cross-provider sample equality is not meaningful."],
  },

  // ---- D · node-identity, well-formedness-only -------------------------
  {
    name: "getIdentity",
    technique: "well-formed",
    techniqueDetail: "Well-formedness gate (availability)",
    shape: "Node-specific identity",
    input: { draws: "Nothing", from: "the request itself (no parameter)", buckets: "1: default" },
    projection: { keeps: "{ wellFormed }: true iff identity is base58-32", drops: "the identity value itself (node-specific, never compared)" },
    match:
      "The identity legitimately differs per node, so there is NO value correctness. project() emits a boolean well-formedness verdict; serving nodes all hash true → byte-equal consensus → correct, a malformed-but-200 body dissents → incorrect. Measures availability + well-formedness only.",
    voters: PANEL,
    notes: ["No cross-provider value check, the same honest limitation as getLatestBlockhash's blockhash value."],
  },
  {
    name: "getVersion",
    technique: "well-formed",
    techniqueDetail: "Well-formedness gate (availability)",
    shape: "Node-specific version",
    input: { draws: "Nothing", from: "the request itself (no parameter)", buckets: "1: default" },
    projection: { keeps: "{ wellFormed }: true iff a string solana-core + integer feature-set are present", drops: "the version values (node-specific, never compared)" },
    match: "Boolean well-formedness verdict, byte-equal, like getIdentity. Availability + well-formedness only.",
    voters: PANEL,
  },

  // ---- E · boolean / health / leader (byte-equal on normalized value) --
  {
    name: "getHealth",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal on { ok }",
    shape: "Node health",
    input: { draws: "Nothing", from: "the request itself (no parameter)", buckets: "1: default" },
    projection: { keeps: "{ ok: result === 'ok' }", drops: "—" },
    match:
      "Byte-equal. An unhealthy node returns a JSON-RPC error (no result) → non-voter on the reliability axis, so it never reaches the projection. In practice this measures availability/reliability.",
    voters: PANEL,
  },
  {
    name: "isBlockhashValid",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal on { valid }",
    shape: "Boolean · blockhash validity",
    input: {
      draws: "A blockhash",
      from: "the utility endpoint's fresh getLatestBlockhash (valid bucket) or a never-real all-zero base58-32 (invalid bucket)",
      buckets: "2: valid / invalid",
    },
    projection: { keeps: "{ valid }", drops: "context.slot" },
    match: "Byte-equal on the boolean. A fresh blockhash stays valid ~150 slots (>30s TTL), so the 'valid' bucket is solidly true at fanout time.",
    voters: PANEL,
  },
  {
    name: "getSlotLeader",
    technique: "well-formed",
    techniqueDetail: "Well-formedness gate (availability)",
    shape: "Current-slot leader pubkey",
    input: {
      draws: "A commitment level",
      from: "the request itself (no on-chain parameter)",
      buckets: "3: processed / confirmed / finalized",
    },
    projection: { keeps: "{ wellFormed }: leader is base58-32", drops: "the leader value (tip-dependent, never compared)" },
    match:
      "Boolean well-formedness, byte-equal (availability/latency probe, C ≈ 100%). The current-slot leader is inherently tip-dependent: providers at slightly different tips return different leaders (leader rotates every 4 slots), so cross-provider value agreement is impossible in real time. Byte-equal scoring would give a misleading low correctness; use getSlotLeaders for the real leader-schedule correctness.",
    voters: PANEL,
    notes: ["No cross-provider value check (same honest limitation as getSlot). See getSlotLeaders for the deterministic, pinned-finalized correctness signal."],
  },
  {
    name: "getSlotLeaders",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Pinned leader-schedule slice",
    input: {
      draws: "A finalized start slot + a fixed limit (20)",
      from: "the recent-slot window (tip−150..9000, finalized)",
      buckets: "1: recent_finalized (no archival: leader schedule for old epochs isn't reliably served, ~50% divergent)",
    },
    projection: { keeps: "the ordered leader pubkeys for [startSlot, startSlot+20)", drops: "—" },
    match: "Byte-equal. The leader schedule for a finalized range is immutable, so every provider returns the identical sequence, the real cross-provider leader-correctness signal getSlotLeader can't give.",
    voters: PANEL,
  },

  // ---- F · simulation (hand-rolled transaction) ------------------------
  {
    name: "simulateTransaction",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal on { err, unitsConsumed }",
    shape: "Memo-tx simulation result",
    input: {
      draws: "A funded fee payer + a fresh blockhash",
      from: "a signer from a recent block + the utility endpoint's getLatestBlockhash; assembled into a constant Memo tx (sigVerify:false, replaceRecentBlockhash:true)",
      buckets: "1: memo",
      commitment: "confirmed",
    },
    projection: { keeps: "{ err, unitsConsumed }", drops: "logs, accounts, returnData, replacementBlockhash" },
    match: "Byte-equal. A Memo tx returns err:null and a deterministic compute-unit count, so the result is identical across providers.",
    voters: PANEL,
  },
  {
    name: "simulateBundle",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal on { summary, perTx }",
    shape: "Memo-bundle simulation result (Jito)",
    input: {
      draws: "A funded fee payer + a fresh blockhash",
      from: "same constant Memo tx as simulateTransaction, wrapped in a 1-tx bundle (skipSigVerify, replaceRecentBlockhash)",
      buckets: "1: memo",
    },
    projection: { keeps: "{ summary, perTx:[{ err, unitsConsumed }] }", drops: "logs, per-account snapshots" },
    match: "Byte-equal. Deterministic for the constant Memo bundle.",
    voters: "3 voters · Helius, Triton, Alchemy (QuickNode and Chainstack do not serve simulateBundle → tier_method_unsupported)",
    notes: [
      "Jito extension; QuickNode and Chainstack both return -32601 and are dropped from the panel (declared unsupported, not penalized).",
      "Config-flag handling is provider-sensitive, so validate live before relying on the correctness number.",
    ],
  },

  {
    name: "getMultipleAccounts",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal hash, structural-only",
    shape: "Mutable account batch · structural slices",
    input: {
      draws: "A batch of ~5 account pubkeys",
      from: "account keys in a probed recent block (any type)",
      buckets: "1: recent_block",
      commitment: "finalized",
    },
    projection: {
      keeps:
        "an ordered array of per-account { exists, owner, executable, space, dataPrefix }, the same account-type-aware structural slice as getAccountInfo",
      drops: "lamports and every mutable balance byte, for every account in the batch",
    },
    match:
      "Byte-equal on the batch structural hash. A match → correct; on a mismatch the divergence is judged by each response's own context.slot vs the majority's freshest read — strictly newer → excluded as fresher-than-panel (no-fault), same slot → incorrect, older → stale. The batch sibling of getAccountInfo.",
    voters: PANEL,
    notes: ["Structural-only by design: verifies the right accounts/owners/layout, not their mutable balances."],
  },
  {
    name: "getSignatureStatuses",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal on { slot, err } per sig",
    shape: "Pinned tx-confirmation statuses",
    input: {
      draws: "~5 transaction signatures",
      from: "a finalized block (transactionDetails:signatures), with searchTransactionHistory:true",
      buckets: "1: finalized",
    },
    projection: {
      keeps: "an ordered array of { slot, err } per signature (err normalized: BorshIoError → unit form)",
      drops: "confirmations (null once rooted) and confirmationStatus (cosmetically 'finalized')",
    },
    match:
      "Byte-equal. Pinned to finalized signatures, so { slot, err } is immutable and identical across providers: the tx-confirmation hot path made deterministic.",
    voters: PANEL,
  },
  {
    name: "getMinimumBalanceForRentExemption",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal on { lamports }",
    shape: "Network constant · rent-exempt minimum",
    input: {
      draws: "A data size",
      from: "the request itself (fixed representative sizes)",
      buckets: "3: zero (0) / token (165) / mint (82)",
    },
    projection: { keeps: "{ lamports }", drops: "—" },
    match: "Byte-equal. Rent params are a fixed network constant per size, so every provider returns the identical lamports.",
    voters: PANEL,
  },
  {
    name: "getStakeMinimumDelegation",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal on { value }",
    shape: "Network constant · min stake delegation",
    input: { draws: "Nothing", from: "the request itself (no parameter)", buckets: "1: default" },
    projection: { keeps: "{ value } (lamports)", drops: "context.slot" },
    match: "Byte-equal. A protocol-fixed network constant, identical across the serving providers.",
    voters:
      "4 voters · Helius, Triton, QuickNode, Chainstack (Alchemy returns \"unsupported method\" for getStakeMinimumDelegation → tier_method_unsupported)",
    notes: [
      "Alchemy is dropped as unsupported (not penalized); the remaining four decide by strict majority.",
      "Standard JSON-RPC method — confirmed live against a Chainstack mainnet endpoint.",
    ],
  },
  {
    name: "getBlocksWithLimit",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal projection hash",
    shape: "Pinned produced-slot list",
    input: {
      draws: "A finalized start slot + a fixed limit (20)",
      from: "the recent-slot window (recent_finalized) / 182–365 epochs ≈1–2 years back (archival)",
      buckets: "2: recent_finalized / archival",
    },
    projection: { keeps: "{ slots } sorted", drops: "—" },
    match: "Byte-equal. Over a finalized range the produced-slot set is immutable. A near-clone of getBlocks.",
    voters: PANEL,
  },
  {
    name: "getRecentPrioritizationFees",
    technique: "well-formed",
    techniqueDetail: "Well-formedness gate (availability)",
    shape: "Recent prioritization-fee window",
    input: { draws: "Nothing", from: "the request itself, network-wide (no addresses)", buckets: "1: default" },
    projection: {
      keeps: "{ wellFormed }: ≥1 entries, each with finite slot/prioritizationFee",
      drops: "the fee values themselves (not cross-compared)",
    },
    match:
      "Boolean well-formedness, byte-equal. Like getRecentPerformanceSamples, providers report fees from their own disjoint recent slots, so a value/Jaccard cross-check never converges; this measures availability + structure.",
    voters: PANEL,
    notes: ["Per-provider fee windows are largely disjoint, so cross-provider fee equality is not meaningful."],
  },
  {
    name: "getClusterNodes",
    technique: "well-formed",
    techniqueDetail: "Well-formedness gate (dormant)",
    shape: "Cluster gossip node set",
    input: { draws: "Nothing", from: "the request itself (no parameter)", buckets: "1: default" },
    projection: {
      keeps: "{ wellFormed }: committed family (Jaccard over node pubkeys is authored but not used; see notes)",
      drops: "gossip/tpu/rpc endpoints and version (node-local, churns)",
    },
    match:
      "Well-formedness, byte-equal (committed family). A Jaccard-over-pubkeys path is authored but rarely reaches a 3-voter majority — the ~4576-node payload only succeeds ~50% under fanout, so ≥3 voters rarely co-occur. Dormant pending re-validation from a deployed worker.",
    voters: PANEL,
    dormant: true,
    notes: ["Dormant: all five providers serve it, but the large payload doesn't reliably reach the 3-voter consensus floor from the dry-run client. Re-enable + re-test from a deployed worker."],
  },
  {
    name: "getLargestAccounts",
    technique: "jaccard",
    techniqueDetail: "Jaccard ≥ 0.75 (dormant)",
    shape: "Largest-account set",
    input: { draws: "Nothing", from: "the request itself (network-wide top accounts)", buckets: "1: default", commitment: "finalized" },
    projection: { keeps: "the account address set (the RPC natively returns ≤20; no cap is applied)", drops: "all lamports balances (only addresses are kept)" },
    match:
      "Jaccard ≥ 0.75 over the address set when served. NOT benchmarkable on the current panel: only QuickNode confirmed serves it (Helius 500s, Triton rate-limits, Alchemy blocks the method); Chainstack returns \"only available on dedicated nodes\" (confirmed live, same restriction as getTokenLargestAccounts). Can never reach 3 voters regardless.",
    voters: PANEL,
    dormant: true,
    notes: ["Dormant: only 1 of 5 panel providers serves getLargestAccounts (QuickNode; Chainstack confirmed dedicated-nodes-only; expensive full-account scan), so consensus is structurally impossible. Re-enable if the panel changes."],
  },
  {
    name: "getFeeForMessage",
    technique: "hybrid",
    techniqueDetail: "Hybrid value-or-fresh",
    shape: "Message fee · lamports or null",
    input: {
      draws: "A funded fee payer + a fresh blockhash",
      from: "a signer from a recent block + the utility endpoint's getLatestBlockhash, assembled into a constant Memo message (base64)",
      buckets: "1: memo",
      commitment: "confirmed",
    },
    projection: {
      keeps: "{ fee } (the number, or null when the blockhash expired); context.slot carried for freshness",
      drops: "everything but the fee value",
    },
    match:
      "Byte-equal on the fee: a ≥3-voter value-majority verifies it (the memo fee is a 5000-lamports/sig constant; all-null also groups when expired panel-wide). If the panel splits between the fee and null (expiry timing), the runner falls back to a freshness verdict on context.slot.",
    voters: PANEL,
  },

  {
    name: "getTransactionsForAddress",
    technique: "byte-equal",
    techniqueDetail: "Byte-equal on a slot-pinned window",
    shape: "Address transaction history (custom method)",
    input: {
      draws: "A non-high-activity signer address + a slot pin",
      from: "transaction signers in a block probed below the pin (pin = tip − 5000 slots ≈ 35 min, deeply finalized); probing below the pin guarantees ≥1 tx inside the filter window",
      buckets: "2: transactionDetails signatures (limit 1000) | full (limit 25, json encoding); both sortOrder desc with filters.slot.lte pinned",
      commitment: "finalized",
    },
    projection: {
      keeps:
        "signatures mode: { signature, slot, err } per entry; full mode: { signature, slot, err, fee, preBalances, postBalances } per tx — both sorted by (slot, signature); err normalized (BorshIoError → unit form)",
      drops:
        "paginationToken (provider-internal cursor), blockTime, memo, confirmationStatus, transactionIndex (vote-tx counting parity unverified), and in full mode the message body, logs, innerInstructions, loadedAddresses, rewards, and version (Triton omits the field entirely)",
    },
    match:
      "Byte-equal. \"The newest ≤limit txs at or before the pin\" is an immutable answer: the finalized-semantics tip drift that forces getSignaturesForAddress into a Jaccard tolerance lives at the tip, which the pin excludes. Yields a 3-provider byte-match across signatures-mode and full-mode probes.",
    voters:
      "3 voters · Helius, Triton, Alchemy (QuickNode serves a non-comparable variant; Chainstack doesn't serve the method at all → both tier_method_unsupported)",
    notes: [
      "Custom indexer-backed method (not in the standard Solana JSON-RPC set). Params stick to the cross-provider common subset: no Helius-only tokenTransfer filter, no processed commitment, full-mode limit under Alchemy's cap.",
      "QuickNode's variant returns a bare array (no {data, paginationToken} envelope), always-full details, and ignores the slot filter — non-comparable by construction, so it's a non-voter rather than penalized.",
      "Chainstack returns -32601 Method not found (confirmed live) — it's a standard Solana core RPC node, and this is a proprietary indexer API, not part of the standard method set.",
      "3-voter panels decide by 2-1 strict majority (the usual ≥3-group floor would demand unanimity): a lone deviator — e.g. Triton's intermittent empty responses — is scored incorrect. All three must answer usably or the challenge is thrown out.",
      "The non-high-activity address filter is load-bearing: vote-authority addresses diverge massively across providers' indexers (vote-tx indexing differs), and filtering them is what makes byte-equal consensus possible.",
    ],
  },
];

const METHOD_BY_NAME: ReadonlyMap<string, MethodSpec> = new Map(
  METHODS.map((m) => [m.name, m]),
);

export interface MethodParamSummary {
  /** Technique family label, e.g. "Byte-equal hash". */
  technique: string;
  /** Short, exact restatement of the match rule, e.g. "Byte-equal projection hash". */
  techniqueDetail: string;
  /** "What kind of answer is this", e.g. "Immutable block (read at confirmed)". */
  shape: string;
  /** Voter-panel line, e.g. "5 voters · Helius, Triton, Alchemy, QuickNode, Chainstack". */
  voters: string;
}

/**
 * Concise, card-safe descriptor for a method — drawn from the *top-level*
 * MethodSpec fields only (techniqueDetail / shape / voters + the technique
 * family label), deliberately avoiding the nested `input.*` prose, which runs
 * long. Returns null for methods not in the Explorer (caller falls back to the
 * bare method name). Shared by the OG share card and any future caller.
 */
export function methodParamSummary(method: string): MethodParamSummary | null {
  const spec = METHOD_BY_NAME.get(method);
  if (!spec) return null;
  return {
    technique: TECHNIQUES[spec.technique].label,
    techniqueDetail: spec.techniqueDetail,
    shape: spec.shape,
    voters: spec.voters,
  };
}
