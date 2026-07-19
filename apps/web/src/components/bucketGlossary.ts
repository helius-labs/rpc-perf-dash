/**
 * Single source of truth for bucket-tag presentation: the color category,
 * pretty label, and plain-English description for every challenge-bucket
 * segment. Both `BucketTags` (the per-row chips) and `BucketLegend` (the
 * central explainer) read from here so they can never drift.
 *
 * Bucket names are `__`-joined dimension segments, e.g.
 * `large__program_heavy__versioned__archival` or `archival__frozen__l100`.
 * Descriptions are generic (one per segment): a few segment names mean
 * slightly different things per method (e.g. `small` = ≤2 instructions for
 * getTransaction vs 1–20 accounts for getProgramAccounts), which the copy
 * notes rather than enumerating per method.
 */

export type TagCategory = "age" | "size" | "flavor" | "default";

export interface SegmentInfo {
  category: TagCategory;
  label: string;
  description: string;
}

const SEGMENTS: Record<string, SegmentInfo> = {
  // age / freshness
  archival:         { category: "age", label: "archival",         description: "Historical data ~1–2 years back (tip−182…365 epochs) — true archive depth." },
  recent:           { category: "age", label: "recent",           description: "Less than ~1 hour old." },
  tip_minus_5:      { category: "age", label: "tip−5",            description: "Within 5 slots of the chain tip (~2s) — freshness probe." },
  last_hour:        { category: "age", label: "last hour",        description: "Between 5 slots and 1 hour back." },
  last_24h:         { category: "age", label: "last 24h",         description: "Between 1 hour and 24 hours back." },
  recent_finalized: { category: "age", label: "recent finalized", description: "A recent, finalized block or range." },
  latest:           { category: "age", label: "latest",           description: "Anchored at the chain-tip cursor." },
  frozen:           { category: "age", label: "frozen",           description: "Immutable window pinned strictly before a 1–2 year anchor; byte-equal consensus." },

  // size / shape
  small:  { category: "size", label: "small",  description: "Small workload — e.g. few instructions or few accounts (exact threshold varies by method)." },
  large:  { category: "size", label: "large",  description: "Large workload — e.g. many instructions (threshold varies by method)." },
  low:    { category: "size", label: "low",    description: "Low activity / small result set." },
  medium: { category: "size", label: "medium", description: "Moderate activity / mid-size result set." },
  high:   { category: "size", label: "high",   description: "High activity / large result set (e.g. ≥1500 signatures in a block)." },

  // tx flavor
  simple:        { category: "flavor", label: "simple",        description: "Only system & token programs." },
  program_heavy: { category: "flavor", label: "program heavy", description: "≥3 distinct programs invoked." },
  legacy:        { category: "flavor", label: "legacy",        description: "Legacy transaction, no address lookup tables." },
  versioned:     { category: "flavor", label: "versioned",     description: "v0 transaction with address lookup tables." },

  // commitment
  processed: { category: "default", label: "processed", description: "Commitment: just entered consensus." },
  confirmed: { category: "default", label: "confirmed", description: "Commitment: majority vote reached." },
  finalized: { category: "default", label: "finalized", description: "Commitment: rooted & finalized." },

  // account / filter / structure types
  wallet:        { category: "default", label: "wallet",        description: "System-owned account (a wallet)." },
  token_account: { category: "default", label: "token account", description: "SPL token account (165 bytes)." },
  mint:          { category: "default", label: "mint",          description: "SPL mint account (82 bytes)." },
  program:       { category: "default", label: "program",       description: "Executable program account." },
  user_wallet:   { category: "default", label: "user wallet",   description: "A user wallet address." },
  nonexistent:   { category: "default", label: "nonexistent",   description: "Address that never maps to a real account." },
  spl:           { category: "default", label: "SPL Token",     description: "Accounts owned by the SPL Token program." },
  t22:           { category: "default", label: "Token-2022",    description: "Base accounts owned by the Token-2022 program." },
  stake:         { category: "default", label: "Stake",         description: "Accounts owned by the Stake program (200 bytes)." },
  by_mint:       { category: "default", label: "by mint",       description: "Filter by mint field (memcmp offset 0)." },
  by_owner:      { category: "default", label: "by owner",      description: "Filter by owner field (memcmp offset 32)." },
  by_voter:      { category: "default", label: "by voter",      description: "Filter by delegated validator vote account (memcmp offset 124)." },
  by_program:    { category: "default", label: "by program",    description: "Filter by program id." },
  few:           { category: "default", label: "few",           description: "1–20 accounts." },
  many:          { category: "default", label: "many",          description: "21–200 accounts." },
  single:        { category: "default", label: "single",        description: "Exactly one account." },
  sigs:          { category: "default", label: "sigs",          description: "Signatures-only response." },
  full:          { category: "default", label: "full",          description: "Full transaction response." },
  desc:          { category: "default", label: "desc",          description: "Newest-first sort order." },
  pinned:        { category: "default", label: "pinned",        description: "Pinned to a fixed slot upper bound." },
  memo:          { category: "default", label: "memo",          description: "Deterministic memo transaction." },
  zero:          { category: "default", label: "zero",          description: "0-byte account size." },
  token:         { category: "default", label: "token",         description: "165-byte (SPL token) account size." },
  valid:         { category: "default", label: "valid",         description: "Fresh, still-valid blockhash." },
  invalid:       { category: "default", label: "invalid",       description: "All-zero blockhash; never valid." },
  recent_block:  { category: "default", label: "recent block",  description: "Keys drawn from a recent block." },
  recent_range:  { category: "default", label: "recent range",  description: "A recent slot range." },
  prev_epoch:    { category: "default", label: "prev epoch",    description: "Previous, completed epoch." },
  current_epoch: { category: "default", label: "current epoch", description: "Current epoch." },
  default:       { category: "default", label: "default",       description: "No parameter variation for this method." },
};

/**
 * Resolve a single bucket segment to its presentation info. Handles the dynamic
 * `lN` limit segments (e.g. `l100`, `l1000`) and falls back to a humanized
 * label with no description for any unknown segment.
 */
export function resolveSegment(part: string): SegmentInfo {
  if (/^l\d+$/.test(part)) {
    return { category: "default", label: `n=${part.slice(1)}`, description: `Result limit of ${part.slice(1)}.` };
  }
  return SEGMENTS[part] ?? { category: "default", label: part.replace(/_/g, " "), description: "" };
}

// Per-category chip colors. The `default` key is load-bearing: it is the
// fallback color for unknown segments in BucketTags and the swatch source in
// BucketLegend — do not drop it.
export const TAG_COLORS: Record<TagCategory, { bg: string; fg: string }> = {
  age:     { bg: "#0e2230", fg: "#7cc6ff" },
  size:    { bg: "#1f1730", fg: "#c4adff" },
  flavor:  { bg: "#2a1f0e", fg: "#f3c27a" },
  default: { bg: "#1a1a1a", fg: "#aaa" },
};

export const CATEGORY_LABELS: Record<TagCategory, string> = {
  age: "Age / freshness",
  size: "Size / structure",
  flavor: "Tx flavor",
  default: "Type / limit / other",
};

const CATEGORY_ORDER: TagCategory[] = ["age", "size", "flavor", "default"];

/**
 * Segments grouped by category in display order, for the central legend. Built
 * once at module load from SEGMENTS (insertion order preserved within a group).
 */
export const LEGEND_GROUPS: ReadonlyArray<{
  category: TagCategory;
  label: string;
  entries: SegmentInfo[];
}> = CATEGORY_ORDER.map((category) => ({
  category,
  label: CATEGORY_LABELS[category],
  entries: Object.values(SEGMENTS).filter((s) => s.category === category),
}));
