/**
 * getTokenSupply method handlers — HYBRID value method.
 *
 * Returns `{ context:{slot}, value:{ amount, decimals, uiAmount, uiAmountString } }`
 * for a mint. `amount` (raw supply) drifts on mint/burn; `decimals` is
 * immutable. We hash `{ amount, decimals }` as the value tier — so the default
 * byte-equal consensus predicate groups voters by supply, a ≥3-voter
 * value-majority verifies the supply, and when supply churned in-window the
 * runner falls back to a freshness verdict via `livenessFallback` instead of
 * dropping. `uiAmount`/`uiAmountString` are dropped (floats; repr varies).
 * See docs/methodology.md and getBalance.ts for the full Hybrid rationale.
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
import { TOKEN_PROGRAM_ID } from "./spl.js";
import { contextSlot, freshnessVerdict, valueDivergenceVerdict } from "./freshness.js";
import { recentBlock, collectSigners, makeTtlCache } from "./probe.js";

export const BUCKETS = ["mint"] as const;
export type GetTokenSupplyBucket = (typeof BUCKETS)[number];

export interface GetTokenSupplyParams {
  mint: string;
  options: { commitment: "finalized" };
}

interface TokenAmount {
  amount?: string;
  decimals?: number;
  uiAmount?: number | null;
  uiAmountString?: string;
}
interface GetTokenSupplyResponse {
  context?: { slot?: number };
  value: TokenAmount | null;
}
// jsonParsed preflight shape — read the base58 `mint` off the utility endpoint.
interface ParsedTokenAccountsResponse {
  value: Array<{ account?: { data?: { parsed?: { info?: { mint?: string } } } } }>;
}

const OPTIONS: GetTokenSupplyParams["options"] = { commitment: "finalized" };

// A mint's identity is immutable, so a recently-validated mint stays a valid
// getTokenSupply target — cache it to skip block-scanning on warm ticks.
const mintCache = makeTtlCache<string>(30 * 60 * 1000);

function isWellFormedSupply(res: GetTokenSupplyResponse | null): boolean {
  return (
    !!res?.value &&
    typeof res.value.decimals === "number" &&
    typeof res.value.amount === "string"
  );
}

function projectImpl(response: GetTokenSupplyResponse): CanonicalProjection {
  const slot = contextSlot(response);
  const v = response?.value ?? null;
  const amount = typeof v?.amount === "string" ? v.amount : "";
  const decimals = typeof v?.decimals === "number" ? v.decimals : -1;
  // Hash the VALUE only ({amount, decimals}); slot rides in shape.
  const hash = hashProjection(canonicalize({ amount, decimals }));
  return { hash, shape: { slot, amount, decimals } };
}

export async function deriveTokenSupplyChallenge(
  ctx: ChallengeContext,
): Promise<{ params: GetTokenSupplyParams; bucket: GetTokenSupplyBucket } | null> {
  // Warm path: reuse a recently-validated mint (1 call, no block scan).
  const cached = mintCache.get("mint");
  if (cached) {
    try {
      const res = await ctx.utility.call<GetTokenSupplyResponse>("getTokenSupply", [cached, OPTIONS]);
      if (isWellFormedSupply(res)) return { params: { mint: cached, options: OPTIONS }, bucket: "mint" };
    } catch {
      // fall through to fresh sourcing
    }
  }

  const block = await recentBlock(ctx);
  if (!block) return null;

  // Source a real mint by reading a recent signer's token accounts (jsonParsed
  // exposes the base58 mint without decoding raw bytes), then confirm
  // getTokenSupply returns a well-formed value for it.
  for (const owner of collectSigners(block)) {
    let parsed: ParsedTokenAccountsResponse;
    try {
      parsed = await ctx.utility.call<ParsedTokenAccountsResponse>("getTokenAccountsByOwner", [
        owner,
        { programId: TOKEN_PROGRAM_ID },
        { encoding: "jsonParsed", commitment: "finalized" },
      ]);
    } catch {
      continue;
    }
    for (const e of parsed?.value ?? []) {
      const mint = e.account?.data?.parsed?.info?.mint;
      if (typeof mint !== "string") continue;
      let res: GetTokenSupplyResponse;
      try {
        res = await ctx.utility.call<GetTokenSupplyResponse>("getTokenSupply", [mint, OPTIONS]);
      } catch {
        continue;
      }
      if (isWellFormedSupply(res)) {
        mintCache.set("mint", mint);
        return { params: { mint, options: OPTIONS }, bucket: "mint" };
      }
    }
  }
  return null;
}

export const handlers: MethodHandlers<GetTokenSupplyParams, GetTokenSupplyResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveTokenSupplyChallenge(ctx);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    if (buffersEqual(projection.hash, reference.hash)) return "correct";
    return valueDivergenceVerdict(projection, reference, providerTipSlot, referenceTipSlot);
  },
  livenessFallback(projection, referenceTipSlot): Correctness {
    return freshnessVerdict(projection, referenceTipSlot);
  },
};

