/** Maintain a rolling buffer of recent slots. Polls getSlot every 400ms. */
import type { RpcClient } from "@rpcbench/shared";

const BUFFER_SIZE = 200;
// Log noisy upstream failures at first hit, then every Nth — enough to surface
// a sustained outage in CloudWatch without spamming when the multi-endpoint
// client is in the middle of failing over.
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
            console.log(
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
          // Don't propagate — silent retries are the right semantic here so
          // a flap doesn't kill the polling loop. But log loudly enough that
          // a sustained outage surfaces in CloudWatch: first failure + every
          // 50th after that. Generator's liveness watchdog handles the
          // hard-fail-stop semantics if challenges actually stop landing.
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
