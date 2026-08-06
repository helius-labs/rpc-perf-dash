/**
 * Scenario builder registry.
 *
 * Transfer needs no config. Raydium/Orca take a `SwapConfig` (the benchmark
 * pool's ordered accounts + mints). The generator constructs the builders once
 * from config and reuses them each tick, flipping `direction` per tick.
 */

export * from "./types.js";
export { TransferBuilder } from "./transfer.js";
export { RaydiumSwapBuilder, RAYDIUM_AMM_V4_PROGRAM } from "./raydium.js";
export { OrcaSwapBuilder, ORCA_WHIRLPOOL_PROGRAM } from "./orca.js";
export {
  WSOL_MINT,
  kitPoolRpc,
  type PoolRpc,
  type SwapConfig,
  type SwapAccountSpec,
} from "./swapCommon.js";
export { DEFAULT_RAYDIUM_CONFIG, DEFAULT_ORCA_CONFIG } from "./defaultPools.js";
