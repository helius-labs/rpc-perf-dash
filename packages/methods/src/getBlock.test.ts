import { test } from "node:test";
import assert from "node:assert/strict";
import type { RpcClient } from "@rpcbench/shared";
import { pickSlotForAge, utilitySlotsPerHour } from "./getBlock.js";

const utilityWith = (samples: { numSlots: number; samplePeriodSecs: number }[]) => {
  let calls = 0;
  const client: RpcClient = {
    call: async <T,>(method: string) => {
      calls++;
      assert.equal(method, "getRecentPerformanceSamples");
      return samples as T;
    },
  };
  return { client, calls: () => calls };
};

test("last_hour and last_24h windows follow the given slot rate", () => {
  const tip = 460_000_000n;
  const slotsPerHour = 17_061n;
  for (let i = 0; i < 200; i++) {
    const hour = pickSlotForAge(tip, "last_hour", slotsPerHour)!;
    assert.ok(hour >= tip - slotsPerHour && hour < tip - 5n);
    const day = pickSlotForAge(tip, "last_24h", slotsPerHour)!;
    assert.ok(day >= tip - slotsPerHour * 24n && day < tip - slotsPerHour);
  }
});

test("the slot rate comes from recent performance samples and is cached", async () => {
  const utility = utilityWith([
    { numSlots: 284, samplePeriodSecs: 60 },
    { numSlots: 285, samplePeriodSecs: 60 },
  ]);
  assert.equal(await utilitySlotsPerHour(utility.client, 1_000), 17_070n);
  assert.equal(await utilitySlotsPerHour(utility.client, 1_000 + 5 * 60 * 1000), 17_070n);
  assert.equal(utility.calls(), 1);
  await utilitySlotsPerHour(utility.client, 1_000 + 11 * 60 * 1000);
  assert.equal(utility.calls(), 2);
});

test("no slot rate without performance samples", async () => {
  assert.equal(await utilitySlotsPerHour(utilityWith([]).client), null);
});
