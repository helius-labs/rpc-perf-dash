/**
 * Run: `pnpm --filter @rpcbench/runner test` (node:test via tsx).
 *
 * End-to-end verification of the correctness-scoring fixes through the REAL
 * consensus + classification pipeline (buildSampleRows → decideConsensus →
 * per-method classify). Synthetic 4-provider fanouts, no network / no DB.
 *
 *   Fix 1 — mutable-value divergence adjudicated by context.slot:
 *            fresher slot → freshness_ahead (no-fault), same slot → incorrect,
 *            older slot → stale.
 *   Fix 2 — BorshIoError serialization skew normalizes away → the dissenter agrees.
 *   Fix 3 — quota/rate-limit body → operational_error (no-fault).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Method } from "@rpcbench/shared";
import { buildSampleRows, type BuildSampleRowsInput } from "./record.js";
import type { ProviderCallResult, SingleResult } from "./fanout.js";

const PANEL = ["helius", "triton", "alchemy", "quicknode"] as const;

function ok(body: string): SingleResult {
  return { latency_ms: 10, status: "ok", http_status: 200, error_code: null, body, timeout_ms: 5000 };
}
function result(res: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: res });
}
function balanceBody(slot: number, lamports: number): string {
  return result({ context: { slot }, value: lamports });
}
function quotaBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32052, message: "You have exceeded your monthly capacity limit." },
  });
}
function blockBody(err: unknown): string {
  return result({
    blockhash: "bh",
    parentSlot: 99,
    previousBlockhash: "pbh",
    transactions: [
      {
        transaction: { signatures: ["sig1"] },
        meta: { err, fee: 5000, preBalances: [10, 20], postBalances: [5, 25] },
      },
    ],
  });
}

/** Run buildSampleRows for a method with a per-provider body map, return the
 *  cold sample row per provider keyed by provider_id. */
function run(
  method: Method,
  bucket: string,
  bodies: Record<string, string>,
  tips: Record<string, bigint>,
) {
  const fanoutResults: ProviderCallResult[] = PANEL.map((id) => {
    const s = ok(bodies[id]!);
    return { provider_id: id, endpoint_used: `https://${id}`, cold: s, warm: s };
  });
  const input: BuildSampleRowsInput = {
    challenge_id: "t",
    method,
    bucket,
    worker_provider: "aws",
    region: "us-east-1",
    worker_id: "w1",
    egress_path: "direct",
    reference_hash: Buffer.alloc(0),
    reference_tip_slot: 100n,
    is_honeypot: false,
    archive: false,
    fanoutResults,
    provider_tip_slots: new Map(PANEL.map((id) => [id, tips[id]!])),
    startedAt: new Date(0),
  };
  const { rows } = buildSampleRows(input);
  const byProvider: Record<string, (typeof rows)[number]> = {};
  for (const r of rows) if (r.connection_mode === "cold") byProvider[r.provider_id] = r;
  return byProvider;
}

// The three panel members that agree share value 1000 @ slot 100.
const AGREE = { triton: balanceBody(100, 1000), alchemy: balanceBody(100, 1000), quicknode: balanceBody(100, 1000) };
const AGREE_TIPS = { helius: 100n, triton: 100n, alchemy: 100n, quicknode: 100n };

test("Fix 1: divergent value at a NEWER slot → freshness_ahead (no-fault, excluded)", () => {
  const rows = run("getBalance", "wallet", { helius: balanceBody(102, 2000), ...AGREE }, AGREE_TIPS);
  assert.equal(rows.helius!.correctness, "ambiguous");
  assert.equal(rows.helius!.exclusion_reason, "freshness_ahead");
  // The agreeing majority stays correct.
  assert.equal(rows.triton!.correctness, "correct");
  assert.equal(rows.alchemy!.exclusion_reason, null);
});

test("Fix 1: divergent value at the SAME slot → incorrect", () => {
  const rows = run("getBalance", "wallet", { helius: balanceBody(100, 2000), ...AGREE }, AGREE_TIPS);
  assert.equal(rows.helius!.correctness, "incorrect");
  assert.equal(rows.helius!.exclusion_reason, "correctness_failure");
});

test("Fix 1: divergent value at an OLDER slot → stale", () => {
  const rows = run("getBalance", "wallet", { helius: balanceBody(98, 2000), ...AGREE }, AGREE_TIPS);
  assert.equal(rows.helius!.correctness, "stale");
  assert.equal(rows.helius!.exclusion_reason, "freshness_stale");
});

test("Fix 1: matching value → correct regardless of slot", () => {
  const rows = run("getBalance", "wallet", { helius: balanceBody(90, 1000), ...AGREE }, AGREE_TIPS);
  assert.equal(rows.helius!.correctness, "correct");
});

test("Fix 3: HTTP-200 quota error body → operational_error (no-fault)", () => {
  const rows = run("getBalance", "wallet", { helius: quotaBody(), ...AGREE }, AGREE_TIPS);
  assert.equal(rows.helius!.correctness, "ambiguous");
  assert.equal(rows.helius!.exclusion_reason, "operational_error");
});

test("Fix 2: BorshIoError legacy vs unit form → dissenter now agrees (correct)", () => {
  const unit = { InstructionError: [4, "BorshIoError"] };
  const legacy = { InstructionError: [4, { BorshIoError: "Unknown" }] };
  const bodies = {
    helius: blockBody(legacy),
    triton: blockBody(unit),
    alchemy: blockBody(unit),
    quicknode: blockBody(unit),
  };
  const rows = run("getBlock", "last_hour__low", bodies, AGREE_TIPS);
  // Post-normalization all four hash equal → helius is in the majority, not a dissenter.
  assert.equal(rows.helius!.correctness, "correct");
  assert.equal(rows.triton!.correctness, "correct");
});

test("control: without normalization a REAL err difference stays incorrect", () => {
  // A genuinely different error (not BorshIoError) must still be caught.
  const bodies = {
    helius: blockBody({ InstructionError: [4, { Custom: 42 }] }),
    triton: blockBody({ InstructionError: [4, { Custom: 1 }] }),
    alchemy: blockBody({ InstructionError: [4, { Custom: 1 }] }),
    quicknode: blockBody({ InstructionError: [4, { Custom: 1 }] }),
  };
  const rows = run("getBlock", "last_hour__low", bodies, AGREE_TIPS);
  assert.equal(rows.helius!.correctness, "incorrect");
});
