/**
 * Run: `pnpm --filter @rpcbench/shared test` (node:test via tsx).
 *
 * normalizeTxErr collapses the BorshIoError serialization skew so functionally
 * identical tx errors hash equal, while preserving meaningful data variants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTxErr } from "./txErr.js";
import { canonicalize, hashProjection } from "./canonical.js";

const hash = (v: unknown) => hashProjection(canonicalize(v)).toString("hex");

test("normalizeTxErr: BorshIoError data-form and unit-form normalize deep-equal", () => {
  const legacy = { InstructionError: [4, { BorshIoError: "Unknown" }] };
  const agave = { InstructionError: [4, "BorshIoError"] };
  assert.deepEqual(normalizeTxErr(legacy), normalizeTxErr(agave));
  assert.deepEqual(normalizeTxErr(agave), { InstructionError: [4, "BorshIoError"] });
});

test("normalizeTxErr: the two forms hash-equal after normalization", () => {
  const legacy = { InstructionError: [4, { BorshIoError: "Io Error: something" }] };
  const agave = { InstructionError: [4, "BorshIoError"] };
  assert.equal(hash(normalizeTxErr(legacy)), hash(normalizeTxErr(agave)));
});

test("normalizeTxErr: preserves meaningful data variants and null", () => {
  assert.equal(normalizeTxErr(null), null);
  assert.equal(normalizeTxErr(undefined), null);
  assert.deepEqual(normalizeTxErr({ InstructionError: [0, { Custom: 6001 }] }), {
    InstructionError: [0, { Custom: 6001 }],
  });
  // A genuinely different error must NOT collapse to equal.
  assert.notEqual(
    hash(normalizeTxErr({ InstructionError: [4, "BorshIoError"] })),
    hash(normalizeTxErr({ InstructionError: [4, { Custom: 1 }] })),
  );
});
