/** Honeypot pool seeding + draw. */
import { sql } from "drizzle-orm";
import { schema, type DbClient, firstRow } from "@rpcbench/db";
import {
  HONEYPOT_INJECTION_RATE,
  HONEYPOT_POOL_TARGET_PER_METHOD,
  type Method,
} from "@rpcbench/shared";
import { HANDLERS } from "@rpcbench/methods";

export async function shouldInjectHoneypot(): Promise<boolean> {
  return Math.random() < HONEYPOT_INJECTION_RATE;
}

/** Draw the least-recently-used honeypot for the given method, mark it used. */
export async function drawHoneypot(
  db: DbClient,
  method: Method,
): Promise<{ id: string; params: unknown; expected_projection: unknown; expected_projection_hash: Buffer } | null> {
  return firstRow<{
    id: string;
    params: unknown;
    expected_projection: unknown;
    expected_projection_hash: Buffer;
  }>(
    db,
    sql`
    UPDATE honeypot_pool
    SET last_used_at = now(), use_count = use_count + 1
    WHERE id = (
      SELECT id FROM honeypot_pool
      WHERE method = ${method}
      ORDER BY last_used_at NULLS FIRST
      LIMIT 1
    )
    RETURNING id, params, expected_projection, expected_projection_hash
  `,
  );
}

/**
 * Seed the honeypot pool by sampling deeply-finalized history.
 *
 * Ground truth comes from the utility endpoint directly: its archival fetch
 * plus a manual operator-side sanity check before publishing the honeypot pool.
 *
 * Run this at initial setup and on monthly refresh.
 */
export async function seedHoneypotPool(opts: {
  db: DbClient;
  method: Method;
  tipSlot: bigint;
  utility: { call: <T>(method: string, params: unknown[]) => Promise<T> };
  methodologyVersion: number;
  /** Number of NEW honeypots to attempt to add. */
  toAdd?: number;
}): Promise<number> {
  const toAdd = opts.toAdd ?? HONEYPOT_POOL_TARGET_PER_METHOD;
  let added = 0;

  // Honeypots replay a known-good answer from deeply-finalized history, so they
  // only make sense for methods with a stable historical answer: getBlock,
  // getTransaction, getSignaturesForAddress. The mutable-state methods
  // (getAccountInfo, getProgramAccounts, getTokenAccountsByOwner) and getSlot
  // have no fixed historical answer to replay — skip them rather than seed
  // garbage via the sigs fallthrough below.
  const HONEYPOT_CAPABLE: readonly Method[] = ["getBlock", "getTransaction", "getSignaturesForAddress"];
  if (!HONEYPOT_CAPABLE.includes(opts.method)) {
    console.log(`[seed-honeypots] ${opts.method} is not honeypot-capable (no stable historical answer) — skipping`);
    return 0;
  }

  for (let i = 0; i < toAdd * 4 && added < toAdd; i++) {
    // Sample from the SCORED archival depth band: tip - [182..365] epochs
    // (≈1–2yr), matching the deepest bucket the leaderboard actually scores
    // (docs/methodology.md § Test ages & archival depth). The honeypot gate is
    // an eligibility gate; seeding it deeper than the scored window (the old
    // [10..1000] range reached ~5.5yr) failed providers on depths no on-board
    // bucket ever shows — e.g. providers passing ~99% at 182–365 were zeroed
    // out by real gaps at 366–1000. Keep the probe depth == the scored depth.
    const epochs = BigInt(182 + Math.floor(Math.random() * 184));
    const slot = opts.tipSlot - epochs * 432_000n;

    let params: unknown[];
    if (opts.method === "getBlock") {
      params = [
        Number(slot),
        { encoding: "json", transactionDetails: "full", maxSupportedTransactionVersion: 0, rewards: false },
      ];
    } else if (opts.method === "getTransaction") {
      // transactionDetails:"signatures" returns a top-level `signatures` array
      // (NOT a `transactions` array) — read from there.
      const block = await opts.utility
        .call<{ signatures?: string[] }>("getBlock", [
          Number(slot),
          { encoding: "json", transactionDetails: "signatures", maxSupportedTransactionVersion: 0, rewards: false },
        ])
        .catch(() => null);
      const sig = block?.signatures?.[0];
      if (!sig) continue;
      params = [
        sig,
        { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" },
      ];
    } else {
      // getSignaturesForAddress: pick an account from the block.
      // transactionDetails: "accounts" returns each tx as { transaction: {accountKeys, signatures}, meta }
      // — no .message wrapper.
      const block = await opts.utility
        .call<{ transactions?: Array<{ transaction: { accountKeys?: string[] } }> }>(
          "getBlock",
          [
            Number(slot),
            { encoding: "json", transactionDetails: "accounts", maxSupportedTransactionVersion: 0, rewards: false },
          ],
        )
        .catch(() => null);
      const addr = block?.transactions?.[0]?.transaction?.accountKeys?.[0];
      if (!addr) continue;
      params = [addr, { limit: 100, commitment: "finalized" }];
    }

    // Fetch ground truth from the utility endpoint. If it errors on these
    // params, skip and try another sample. (Operator should review honeypot
    // params manually before publishing the pool.)
    let reference: unknown;
    try {
      reference = await opts.utility.call(opts.method, params);
    } catch {
      continue;
    }
    if (reference == null) continue;

    const projection = HANDLERS[opts.method].project(reference);
    await opts.db
      .insert(schema.honeypot_pool)
      .values({
        method: opts.method,
        params: params,
        expected_projection_hash: Buffer.from(projection.hash),
        expected_projection: projection.shape,
        methodology_version: opts.methodologyVersion,
      })
      .onConflictDoNothing();
    added++;
  }

  return added;
}
