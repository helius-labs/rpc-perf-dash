import { createHash, createHmac } from "node:crypto";

export function generateSeed(secret: string, slot: bigint, timestamp: number): Buffer {
  return createHmac("sha256", secret)
    .update(`${slot.toString()}:${timestamp.toString()}`)
    .digest();
}

export function commitmentHash(seed: Buffer, params: unknown): Buffer {
  const paramsJson = JSON.stringify(params);
  return createHash("sha256")
    .update(seed)
    .update(paramsJson, "utf8")
    .digest();
}
