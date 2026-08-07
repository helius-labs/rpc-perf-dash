/**
 * Unit tests for the harvest sweep decision — the one piece of harvest with money
 * semantics. Roster sweeps only genuine excess and lands at the exact float; orphans
 * drain to *exactly 0* so the account is purged (leaving dust would fail the bank's
 * rent-state check → InsufficientFundsForRent, the bug that made the orphan path dead
 * code in prod). Run: `pnpm --filter @rpcbench/send test` (node:test via tsx).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepAmount } from "./harvest.js";
import { TRANSFER_FEE_LAMPORTS, sendTargetOf } from "./wallets.js";

const FLOOR = 30_000_000n; // 0.03 SOL
const CEIL = 50_000_000n; // 0.05 SOL
const opts = { activeFloorLamports: FLOOR, sweepCeilingLamports: CEIL };

test("orphan drains to exactly 0 (amount = native − fee → account purged)", () => {
  const native = 20_000_000n; // a funded-then-retired wallet (~one 0.02 SOL topup)
  const amount = sweepAmount(native, true, opts);
  assert.equal(amount, native - TRANSFER_FEE_LAMPORTS);
  // Source pays the fee first, then transfers `amount`, so it lands at exactly 0.
  assert.equal(native - TRANSFER_FEE_LAMPORTS - amount, 0n);
});

test("orphan with balance at/below the fee is skipped (nothing worth draining)", () => {
  assert.equal(sweepAmount(TRANSFER_FEE_LAMPORTS, true, opts), 0n);
  assert.equal(sweepAmount(TRANSFER_FEE_LAMPORTS - 1n, true, opts), 0n);
  assert.equal(sweepAmount(0n, true, opts), 0n);
});

test("orphan in the rent-paying post-fee band is skipped (no InsufficientFundsForRent loop)", () => {
  const RENT_MIN = 890_880n;
  // post-fee balance lands in (0, RENT_MIN) → validate_fee_payer rejects → skip.
  assert.equal(sweepAmount(TRANSFER_FEE_LAMPORTS + 1n, true, opts), 0n);
  assert.equal(sweepAmount(TRANSFER_FEE_LAMPORTS + RENT_MIN - 1n, true, opts), 0n);
  // post-fee balance exactly at the rent-exempt minimum → drainable.
  const atMin = TRANSFER_FEE_LAMPORTS + RENT_MIN;
  assert.equal(sweepAmount(atMin, true, opts), RENT_MIN);
});

test("roster below the ceiling is NOT swept (no sweep↔topup churn)", () => {
  assert.equal(sweepAmount(FLOOR, false, opts), 0n);
  assert.equal(sweepAmount(CEIL, false, opts), 0n);
  assert.equal(sweepAmount(CEIL - 1n, false, opts), 0n);
});

test("roster above the ceiling lands at EXACTLY the active float after fee", () => {
  const native = 80_000_000n; // 0.08 SOL, above the 0.05 ceiling
  const amount = sweepAmount(native, false, opts);
  // final = native − fee − amount must equal the float.
  assert.equal(native - TRANSFER_FEE_LAMPORTS - amount, FLOOR);
});

test("sendTargetOf: roster/orphan classification — column wins, name-prefix is the fallback", () => {
  const roster = new Set(["helius", "triton"]);
  // Column present → used verbatim (roster).
  assert.equal(sendTargetOf({ name: "helius:orca_swap", sendTarget: "helius" }), "helius");
  assert.equal(roster.has(sendTargetOf({ name: "helius:orca_swap", sendTarget: "helius" })), true);
  // Column present for a retired target → orphan (not in the roster set).
  assert.equal(roster.has(sendTargetOf({ name: "oldrpc:transfer", sendTarget: "oldrpc" })), false);
  // Column NULL (hand-inserted row) → fall back to the name prefix.
  assert.equal(sendTargetOf({ name: "helius:raydium_swap", sendTarget: null }), "helius");
  assert.equal(roster.has(sendTargetOf({ name: "helius:raydium_swap", sendTarget: null })), true);
  // Column takes precedence over a mismatched name prefix.
  assert.equal(sendTargetOf({ name: "helius:transfer", sendTarget: "triton" }), "triton");
});
