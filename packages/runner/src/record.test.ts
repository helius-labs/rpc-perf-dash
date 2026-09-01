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
 *
 * Plus the raw_response storage bound (2026-08-31): a passing honeypot must NOT
 * retain a body, a failing one must, and every retained body must be capped.
 *
 * Plus the reduced-panel regime: getTransactionsForAddress is down to two
 * structural voters (Helius, Alchemy), so both consensus floors relax to 2 and
 * the two of them agreeing scores the method instead of every challenge dying
 * as `no_consensus`. See consensusFloorsForMethod() in providers.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTransactionsForAddress } from "@rpcbench/methods";
import type { Method } from "@rpcbench/shared";
import { buildSampleRows, cappedRaw, type BuildSampleRowsInput } from "./record.js";
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
  return runPanel(PANEL, method, bucket, bodies, tips);
}

/** `run` over an explicit panel — the reduced-panel methods need the full
 *  5-provider roster, including the ones declared unsupported. */
function runPanel(
  panel: readonly string[],
  method: Method,
  bucket: string,
  bodies: Record<string, string>,
  tips: Record<string, bigint>,
) {
  const fanoutResults: ProviderCallResult[] = panel.map((id) => {
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
    provider_tip_slots: new Map(panel.map((id) => [id, tips[id]!])),
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

/** `runPanel` with honeypot wiring — the caller supplies the pre-seeded
 *  reference hash that the honeypot classifier scores against. */
function runHoneypot(
  method: Method,
  bucket: string,
  bodies: Record<string, string>,
  tips: Record<string, bigint>,
  reference_hash: Buffer,
) {
  const fanoutResults: ProviderCallResult[] = PANEL.map((id) => {
    const single = ok(bodies[id]!);
    return { provider_id: id, endpoint_used: `https://${id}`, cold: single, warm: single };
  });
  const input: BuildSampleRowsInput = {
    challenge_id: "t",
    method,
    bucket,
    worker_provider: "aws",
    region: "us-east-1",
    worker_id: "w1",
    egress_path: "direct",
    reference_hash,
    reference_tip_slot: 100n,
    is_honeypot: true,
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

// ────────────────────────────────────────────────────────────────────────
// raw_response storage bound (see RAW_RESPONSE_MAX_CHARS in record.ts)
// ────────────────────────────────────────────────────────────────────────

test("cap: a body at or under the ceiling is stored verbatim", () => {
  const body = balanceBody(100, 1000);
  assert.ok(body.length < 32 * 1024);
  assert.deepEqual(cappedRaw(body), JSON.parse(body));
});

test("cap: an oversized body is truncated, and records what it truncated", () => {
  const huge = result({ context: { slot: 100 }, value: 1000, pad: "x".repeat(5_000_000) });
  const capped = cappedRaw(huge) as { truncated: boolean; original_length: number; prefix: string };
  assert.equal(capped.truncated, true);
  assert.equal(capped.original_length, huge.length);
  assert.equal(capped.prefix.length, 32 * 1024);
  // The whole point: what we store is bounded no matter how big the response is.
  assert.ok(JSON.stringify(capped).length < 40 * 1024, "stored payload must stay ~32 KiB");
});

test("honeypot that PASSES retains NO raw_response (the 2.18 TB regression)", () => {
  // Two passes: the first, against a deliberately-wrong reference, surfaces the
  // real projection hash on the row; the second uses it so the honeypot passes.
  const bodies = { helius: balanceBody(100, 1000), ...AGREE };
  const wrong = runHoneypot("getBalance", "wallet", bodies, AGREE_TIPS, Buffer.alloc(32, 1));
  assert.equal(wrong.helius!.correctness, "incorrect");
  assert.notEqual(wrong.helius!.raw_response, null, "a honeypot MISS must keep its body");

  const trueHash = Buffer.from(wrong.helius!.response_hash as Uint8Array);
  const passing = runHoneypot("getBalance", "wallet", bodies, AGREE_TIPS, trueHash);
  assert.equal(passing.helius!.correctness, "correct");
  assert.equal(
    passing.helius!.raw_response,
    null,
    "a PASSING honeypot must not store its body — this predicate was ~99% of a 2.18 TB database",
  );
});

test("cap: a retained honeypot MISS with a multi-MB body is still bounded", () => {
  // A honeypot miss is exactly the row we DO keep, so it is the row that must
  // prove the cap holds end-to-end through buildSampleRows.
  const huge = result({ context: { slot: 100 }, value: 999, pad: "x".repeat(5_000_000) });
  const rows = runHoneypot(
    "getBalance",
    "wallet",
    { helius: huge, ...AGREE },
    AGREE_TIPS,
    Buffer.alloc(32, 1),
  );
  const stored = rows.helius!.raw_response;
  assert.notEqual(stored, null, "a miss must keep a body");
  assert.ok(
    JSON.stringify(stored).length < 40 * 1024,
    `stored raw_response was ${JSON.stringify(stored).length} bytes — the cap is not applied`,
  );
});

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

// ── Reduced-panel consensus (getTransactionsForAddress) ────────────────

const GTFA_SIGS_BUCKET = getTransactionsForAddress.GTFA_SIGS_BUCKET;
const GTFA_PANEL = ["helius", "triton", "alchemy", "quicknode", "chainstack"] as const;
const GTFA_TIPS = Object.fromEntries(GTFA_PANEL.map((id) => [id, 100n]));

/** Signatures-mode gTFA body — `data` entries plus the dropped cursor. */
function gtfaBody(sigs: Array<{ signature: string; slot: number }>): string {
  return result({
    data: sigs.map((e) => ({ ...e, err: null, memo: null, blockTime: 1, confirmationStatus: "finalized" })),
    paginationToken: "cursor-differs-per-provider",
  });
}
function methodNotFoundBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32601, message: "Method not found" },
  });
}

const GTFA_ANSWER = gtfaBody([
  { signature: "sigA", slot: 90 },
  { signature: "sigB", slot: 91 },
]);

test("gTFA: the 3 voters agreeing → all correct", () => {
  const rows = runPanel(GTFA_PANEL, "getTransactionsForAddress", GTFA_SIGS_BUCKET, {
    helius: GTFA_ANSWER,
    alchemy: GTFA_ANSWER,
    // Quicknode's variant became comparable in Aug 2026 — it votes again.
    quicknode: GTFA_ANSWER,
    // Triton dropped the method; Chainstack never served it. Both are
    // declared unsupported.
    triton: methodNotFoundBody(),
    chainstack: methodNotFoundBody(),
  }, GTFA_TIPS);

  for (const id of ["helius", "alchemy", "quicknode"]) {
    assert.equal(rows[id]!.correctness, "correct", id);
    assert.equal(rows[id]!.exclusion_reason, null, id);
  }
});

test("gTFA: Triton's -32601 is tier_method_unsupported, not a correctness failure", () => {
  const rows = runPanel(GTFA_PANEL, "getTransactionsForAddress", GTFA_SIGS_BUCKET, {
    helius: GTFA_ANSWER,
    alchemy: GTFA_ANSWER,
    triton: methodNotFoundBody(),
    quicknode: GTFA_ANSWER,
    chainstack: methodNotFoundBody(),
  }, GTFA_TIPS);

  for (const id of ["triton", "chainstack"]) {
    assert.equal(rows[id]!.correctness, "ambiguous", id);
    assert.equal(rows[id]!.exclusion_reason, "tier_method_unsupported", id);
  }
});

test("gTFA: a 2-1 split is decided and the deviator attributed (minGroup=2)", () => {
  const rows = runPanel(GTFA_PANEL, "getTransactionsForAddress", GTFA_SIGS_BUCKET, {
    helius: GTFA_ANSWER,
    quicknode: GTFA_ANSWER,
    alchemy: gtfaBody([{ signature: "sigA", slot: 90 }]),
    triton: methodNotFoundBody(),
    chainstack: methodNotFoundBody(),
  }, GTFA_TIPS);

  for (const id of ["helius", "quicknode"]) {
    assert.equal(rows[id]!.correctness, "correct", id);
    assert.equal(rows[id]!.exclusion_reason, null, id);
  }
  assert.equal(rows.alchemy!.correctness, "incorrect");
});

test("gTFA: a three-way split → no_consensus for all (largest group is 1)", () => {
  const rows = runPanel(GTFA_PANEL, "getTransactionsForAddress", GTFA_SIGS_BUCKET, {
    helius: GTFA_ANSWER,
    alchemy: gtfaBody([{ signature: "sigA", slot: 90 }]),
    quicknode: gtfaBody([{ signature: "sigB", slot: 91 }]),
    triton: methodNotFoundBody(),
    chainstack: methodNotFoundBody(),
  }, GTFA_TIPS);

  for (const id of ["helius", "alchemy", "quicknode"]) {
    assert.equal(rows[id]!.correctness, "ambiguous", id);
    assert.equal(rows[id]!.exclusion_reason, "no_consensus", id);
  }
});

test("gTFA: one voter timing out → no_consensus (minVoters=3, all three must answer)", () => {
  const fanoutResults: ProviderCallResult[] = GTFA_PANEL.map((id) => {
    const s: SingleResult =
      id === "alchemy"
        ? { latency_ms: 5000, status: "timeout", http_status: null, error_code: "timeout", body: null, timeout_ms: 5000 }
        : ok(id === "triton" || id === "chainstack" ? methodNotFoundBody() : GTFA_ANSWER);
    return { provider_id: id, endpoint_used: `https://${id}`, cold: s, warm: s };
  });
  const { rows } = buildSampleRows({
    challenge_id: "t",
    method: "getTransactionsForAddress",
    bucket: GTFA_SIGS_BUCKET,
    worker_provider: "aws",
    region: "us-east-1",
    worker_id: "w1",
    egress_path: "direct",
    reference_hash: Buffer.alloc(0),
    reference_tip_slot: 100n,
    is_honeypot: false,
    archive: false,
    fanoutResults,
    provider_tip_slots: new Map(GTFA_PANEL.map((id) => [id, 100n])),
    startedAt: new Date(0),
  });
  const helius = rows.find((r) => r.provider_id === "helius" && r.connection_mode === "cold")!;
  assert.equal(helius.correctness, "ambiguous");
  assert.equal(helius.exclusion_reason, "no_consensus");
});
