/**
 * getProgramAccounts method handlers (base method — no V2 pagination).
 *
 * Two hard problems, both addressed here:
 *  1. BOUNDEDNESS. Unbounded getProgramAccounts can return millions of accounts.
 *     Every challenge sends a `filters` array (dataSize + memcmp anchored to a
 *     value derived at challenge time) and a server-side `dataSlice` over only
 *     the immutable bytes, and deriveChallenge preflights the query and rejects
 *     anchors whose result exceeds MAX_PGA_ACCOUNTS.
 *  2. MUTABLE STATE. The accounts returned have mutable fields (token balances,
 *     stake amounts), so byte-equal consensus over their full contents is
 *     unreachable. The projection is STRUCTURAL-ONLY: the server-side dataSlice
 *     captures a program-specific immutable prefix and excludes the mutable
 *     bytes. Measures "the right account SET with the right identity", not
 *     balances.
 *
 * Program coverage (see PGA_PROGRAMS):
 *   - SPL Token  (key `spl`) — account 165 bytes; slice [0,64) = mint+owner.
 *   - Token-2022 (key `t22`) — no dataSize filter, because real Token-2022
 *                              accounts carry extensions (>165 bytes) that a
 *                              fixed dataSize would exclude. The base layout is
 *                              unchanged — mint@0, owner@32, extensions appended
 *                              after byte 165 — so the memcmp anchors and the
 *                              [0,64) slice stay valid for every account size.
 *   - Stake      (key `stake`) — account 200 bytes; slice [0,156) captures the
 *                              discriminant, Meta (authorities + lockup) and the
 *                              delegation's voter_pubkey. The mutable stake
 *                              amount / epochs / credits_observed all live in the
 *                              trailing [156,200) and are dropped. Anchored by
 *                              the validator vote account (memcmp offset 124).
 *
 * Buckets: program × filter_kind × result_size_band:
 *   spl / t22:  by_mint (memcmp 0) | by_owner (memcmp 32)
 *   stake:      by_voter (memcmp 124)
 *   size_band:  small (1–20) | medium (21–MAX_PGA_ACCOUNTS)
 *
 * NOTE (Stake): the Stake buckets have not yet been validated against the live
 * benchmarked panel. Confirm they reach consensus (samples land `correct`, not
 * perpetual `no_consensus`) before trusting their scores — see the anchor and
 * boundedness caveats in deriveProgramAccountsChallenge.
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
  buffersEqual,
} from "@rpcbench/shared";
import { STALE_TIP_LAG_SLOTS } from "./freshness.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  SPL_TOKEN_ACCOUNT_SIZE,
  TOKEN_ACCOUNT_STRUCTURAL_LEN,
  dataString,
} from "./spl.js";

const SIZE_BAND = ["small", "medium"] as const;

const VOTE_PROGRAM_ID = "Vote111111111111111111111111111111111111111";
const STAKE_PROGRAM_ID = "Stake11111111111111111111111111111111111111";
/** StakeStateV2 is a fixed 200 bytes. */
const STAKE_ACCOUNT_SIZE = 200;
/**
 * Immutable prefix of a stake account: discriminant (4) + Meta (rent reserve,
 * Authorized{staker,withdrawer}, Lockup) + Delegation.voter_pubkey, ending just
 * before Delegation.stake. Everything after 156 (stake amount, activation /
 * deactivation epochs, warmup rate, credits_observed) is mutable.
 */
const STAKE_STRUCTURAL_LEN = 156;
/** Delegation.voter_pubkey offset within a stake account. */
const STAKE_VOTER_OFFSET = 124;

/**
 * How a filter's anchor value is discovered and validated at challenge time.
 *   owner → a transaction signer, used directly (no validation).
 *   mint  → an account key confirmed (via jsonParsed) to be a mint of the
 *           target program — works for both SPL and Token-2022, extension mints
 *           included.
 *   voter → an account key confirmed to be owned by the Vote program.
 */
type AnchorKind = "owner" | "mint" | "voter";

interface PgaFilterSpec {
  /** Bucket-key segment, e.g. "by_mint" / "by_owner" / "by_voter". */
  kind: string;
  /** memcmp offset the anchor is matched at. */
  offset: number;
  anchor: AnchorKind;
}

/**
 * A getProgramAccounts-benchmarkable program. Adding a program means giving it
 * a structural slice over only the immutable bytes and one or more anchor
 * filters. `accountSize` is an optional dataSize filter — set it only when the
 * program's target accounts are a fixed size (classic SPL Token), and omit it
 * when accounts vary (Token-2022 with extensions), where the memcmp anchor
 * alone is selective enough.
 */
interface PgaProgramSpec {
  /** Bucket-key prefix. */
  key: string;
  programId: string;
  /** Optional dataSize filter (fixed-size accounts only). */
  accountSize?: number;
  /** Server-side dataSlice capturing only the immutable structural prefix. */
  structuralSlice: { offset: number; length: number };
  filters: readonly PgaFilterSpec[];
}

const TOKEN_FILTERS: readonly PgaFilterSpec[] = [
  { kind: "by_mint", offset: 0, anchor: "mint" },
  { kind: "by_owner", offset: 32, anchor: "owner" },
];
const TOKEN_SLICE = { offset: 0, length: TOKEN_ACCOUNT_STRUCTURAL_LEN };

export const PGA_PROGRAMS: readonly PgaProgramSpec[] = [
  // Classic SPL token accounts are a fixed 165 bytes, so the dataSize filter
  // adds selectivity for free.
  { key: "spl", programId: TOKEN_PROGRAM_ID, accountSize: SPL_TOKEN_ACCOUNT_SIZE, structuralSlice: TOKEN_SLICE, filters: TOKEN_FILTERS },
  // Token-2022: no dataSize filter — extension accounts are larger than 165 and
  // would be excluded. mint@0 / owner@32 / the [0,64) slice hold regardless.
  { key: "t22", programId: TOKEN_2022_PROGRAM_ID, structuralSlice: TOKEN_SLICE, filters: TOKEN_FILTERS },
  {
    key: "stake",
    programId: STAKE_PROGRAM_ID,
    accountSize: STAKE_ACCOUNT_SIZE,
    structuralSlice: { offset: 0, length: STAKE_STRUCTURAL_LEN },
    filters: [{ kind: "by_voter", offset: STAKE_VOTER_OFFSET, anchor: "voter" }],
  },
];

const PROGRAM_BY_KEY = new Map(PGA_PROGRAMS.map((p) => [p.key, p]));

export const BUCKETS = PGA_PROGRAMS.flatMap((p) =>
  p.filters.flatMap((f) => SIZE_BAND.map((s) => `${p.key}__${f.kind}__${s}`)),
);
export type GetProgramAccountsBucket = (typeof BUCKETS)[number];

interface ParsedBucket {
  spec: PgaProgramSpec;
  filter: PgaFilterSpec;
  band: "small" | "medium";
}

function parseBucket(bucket: string): ParsedBucket | null {
  const [progKey, filterKind, band] = bucket.split("__");
  const spec = progKey ? PROGRAM_BY_KEY.get(progKey) : undefined;
  if (!spec) return null;
  const filter = spec.filters.find((f) => f.kind === filterKind);
  if (!filter) return null;
  if (band !== "small" && band !== "medium") return null;
  return { spec, filter, band };
}

/** Upper bound on accounts a single challenge may return. Keeps payloads and
 * cross-provider set comparison tractable. */
export const MAX_PGA_ACCOUNTS = 200;
const SMALL_MAX = 20;

export interface GetProgramAccountsParams {
  programId: string;
  options: {
    encoding: "base64";
    commitment: "finalized";
    filters: Array<{ dataSize: number } | { memcmp: { offset: number; bytes: string } }>;
    dataSlice: { offset: number; length: number };
  };
}

interface ProgramAccountEntry {
  pubkey: string;
  account: { owner: string; data: [string, string] | unknown };
}
// getProgramAccounts (base method, no withContext) returns a bare array.
type GetProgramAccountsResponse = ProgramAccountEntry[];

function bandOf(count: number): "small" | "medium" | null {
  if (count <= 0 || count > MAX_PGA_ACCOUNTS) return null;
  return count <= SMALL_MAX ? "small" : "medium";
}

function projectImpl(response: GetProgramAccountsResponse): CanonicalProjection {
  const accounts = (response ?? [])
    .map((e) => ({
      pubkey: e.pubkey,
      owner: e.account?.owner ?? "",
      // data is already the immutable structural slice, sliced server-side via
      // dataSlice — no mutable balance / stake bytes.
      dataPrefix: dataString(e.account?.data),
    }))
    .sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
  const projection = { accounts };
  return { hash: hashProjection(canonicalize(projection)), shape: projection };
}

/** Empty slice used for the boundedness preflight — see deriveChallenge. */
const COUNT_ONLY_SLICE = { offset: 0, length: 0 };

function optionsFor(
  spec: PgaProgramSpec,
  filter: PgaFilterSpec,
  anchor: string,
  slice: { offset: number; length: number } = spec.structuralSlice,
): GetProgramAccountsParams["options"] {
  const filters: GetProgramAccountsParams["options"]["filters"] = [];
  if (spec.accountSize !== undefined) filters.push({ dataSize: spec.accountSize });
  filters.push({ memcmp: { offset: filter.offset, bytes: anchor } });
  return {
    encoding: "base64",
    commitment: "finalized",
    filters,
    dataSlice: { offset: slice.offset, length: slice.length },
  };
}

interface AccountKeyEntry {
  pubkey: string;
  signer?: boolean;
}
interface BlockKeysProbe {
  transactions: Array<{ transaction: { accountKeys?: AccountKeyEntry[] } }>;
}
interface AccountInfoProbe {
  value: { owner: string; executable: boolean; space?: number } | null;
}
interface ParsedAccountProbe {
  value: { owner: string; data?: { parsed?: { type?: string } } } | null;
}

/** Validate a candidate anchor for the filter's anchor kind. */
async function isValidAnchor(
  ctx: ChallengeContext,
  spec: PgaProgramSpec,
  filter: PgaFilterSpec,
  candidate: string,
): Promise<boolean> {
  if (filter.anchor === "owner") return true; // signers used directly

  if (filter.anchor === "mint") {
    // jsonParsed identifies a mint for both SPL Token and Token-2022, including
    // extension mints (a size check can't, since extension mints exceed 82).
    let probe: ParsedAccountProbe;
    try {
      probe = await ctx.utility.call<ParsedAccountProbe>("getAccountInfo", [
        candidate,
        { encoding: "jsonParsed", commitment: "finalized" },
      ]);
    } catch {
      return false;
    }
    const v = probe?.value;
    return !!v && v.owner === spec.programId && v.data?.parsed?.type === "mint";
  }

  // voter: any account owned by the Vote program is a valid delegation target.
  let probe: AccountInfoProbe;
  try {
    probe = await ctx.utility.call<AccountInfoProbe>("getAccountInfo", [
      candidate,
      { encoding: "base64", commitment: "finalized" },
    ]);
  } catch {
    return false;
  }
  return probe?.value?.owner === VOTE_PROGRAM_ID;
}

export async function deriveProgramAccountsChallenge(
  ctx: ChallengeContext,
  bucket: GetProgramAccountsBucket,
): Promise<{ params: GetProgramAccountsParams; bucket: GetProgramAccountsBucket } | null> {
  const parsed = parseBucket(bucket);
  if (!parsed) return null;
  const { spec, filter, band } = parsed;
  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip === 0n) return null;

  const probeSlot = tip - BigInt(1 + Math.floor(Math.random() * 9000));
  let block: BlockKeysProbe;
  try {
    block = await ctx.utility.call<BlockKeysProbe>("getBlock", [
      Number(probeSlot),
      { encoding: "json", transactionDetails: "accounts", maxSupportedTransactionVersion: 0, rewards: false, commitment: "confirmed" },
    ]);
  } catch {
    return null;
  }

  // Candidate anchors:
  //   owner → transaction signers (base58 wallet pubkeys, used at offset 32).
  //   mint  → account keys later confirmed to be mints of this program.
  //   voter → account keys later confirmed to be Vote-program accounts. Votes
  //           dominate block traffic, so vote accounts are abundant here; the
  //           band preflight below then filters to validators whose delegator
  //           set fits under MAX_PGA_ACCOUNTS.
  const wantSignersOnly = filter.anchor === "owner";
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const tx of block.transactions ?? []) {
    for (const k of tx.transaction.accountKeys ?? []) {
      if (!k || typeof k.pubkey !== "string" || seen.has(k.pubkey)) continue;
      if (wantSignersOnly && k.signer !== true) continue;
      seen.add(k.pubkey);
      candidates.push(k.pubkey);
    }
    if (candidates.length > 120) break;
  }

  for (const anchor of candidates) {
    if (!(await isValidAnchor(ctx, spec, filter, anchor))) continue;

    // Preflight with an empty dataSlice: we only need the match COUNT for the
    // band check, and a popular mint / large validator can be thousands of
    // accounts — no reason to download their data just to discard it. `dataSlice`
    // changes only the bytes returned per account, never which accounts match,
    // so the count is identical to the real query below.
    let count: number;
    try {
      const preflight = await ctx.utility.call<GetProgramAccountsResponse>("getProgramAccounts", [
        spec.programId,
        optionsFor(spec, filter, anchor, COUNT_ONLY_SLICE),
      ]);
      count = preflight?.length ?? 0;
    } catch {
      continue;
    }
    if (bandOf(count) === band) {
      // Store the real challenge params with the structural slice.
      return { params: { programId: spec.programId, options: optionsFor(spec, filter, anchor) }, bucket };
    }
  }
  return null;
}

export const handlers: MethodHandlers<GetProgramAccountsParams, GetProgramAccountsResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveProgramAccountsChallenge(ctx, ctx.bucket as GetProgramAccountsBucket);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    if (buffersEqual(projection.hash, reference.hash)) {
      if (referenceTipSlot - providerTipSlot > STALE_TIP_LAG_SLOTS) return "stale";
      return "correct";
    }
    // Hash mismatch — typically set-membership churn (an account opened/closed
    // between slots). A provider at a newer slot is fresh-but-divergent → stale.
    if (providerTipSlot > referenceTipSlot) return "stale";
    return "incorrect";
  },
};
