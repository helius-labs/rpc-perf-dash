/**
 * Rolling buffer of recent slots. Copied verbatim from
 * apps/generator/src/observe.ts to keep the CLI standalone. Polls getSlot every
 * 400ms against any RpcClient. Pure — no secret/DB.
 */
import type { RpcClient } from "@rpcbench/shared";

const BUFFER_SIZE = 200;
const LOG_EVERY_NTH_FAILURE = 50;

export class SlotObserver {
  private slots: bigint[] = [];
  private intervalId: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;

  constructor(
    private utility: RpcClient,
    private intervalMs = 400,
  ) {}

  start(): void {
    this.intervalId = setInterval(() => {
      this.utility
        .call<number>("getSlot", [{ commitment: "finalized" }])
        .then((slot) => {
          if (this.consecutiveFailures > 0) {
            console.error(
              `[slot-observer] recovered after ${this.consecutiveFailures} failure(s)`,
            );
            this.consecutiveFailures = 0;
          }
          const last = this.slots.length ? this.slots[this.slots.length - 1]! : 0n;
          if (BigInt(slot) > last) {
            this.slots.push(BigInt(slot));
            if (this.slots.length > BUFFER_SIZE) this.slots.shift();
          }
        })
        .catch((err) => {
          this.consecutiveFailures += 1;
          if (
            this.consecutiveFailures === 1 ||
            this.consecutiveFailures % LOG_EVERY_NTH_FAILURE === 0
          ) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[slot-observer] getSlot failed (${this.consecutiveFailures}x): ${msg}`,
            );
          }
        });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  recentSlots(): readonly bigint[] {
    return this.slots;
  }

  tipSlot(): bigint {
    return this.slots.length ? this.slots[this.slots.length - 1]! : 0n;
  }
}
