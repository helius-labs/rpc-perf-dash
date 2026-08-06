/**
 * Built-in benchmark pool configs. The send benchmark uses fixed, published
 * SOL/USDC pools, so their config lives in code (not per-deployment env) — the
 * worker falls back to these when `SEND_RAYDIUM_CONFIG` / `SEND_ORCA_CONFIG`
 * aren't set. Addresses are the ones documented in docs/methodology.md § Open
 * data and validated on-chain (simulate + land).
 */

import type { SwapConfig } from "./swapCommon.js";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** 0.0002 SOL / equivalent per swap — tiny, direction flips to bound inventory. */
const SWAP_AMOUNT_LAMPORTS = 200_000;

/**
 * Raydium AMM v4 SOL/USDC pool. `accounts` is the faithful 17-account
 * swap_base_in layout MINUS the 3 user accounts (token program … vault signer,
 * NO target_orders) — the builder appends user source/dest/owner.
 */
export const DEFAULT_RAYDIUM_CONFIG: SwapConfig & { poolAddress: string } = {
  poolAddress: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
  programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  swapAmountLamports: SWAP_AMOUNT_LAMPORTS,
  tokenAMint: WSOL,
  tokenBMint: USDC,
  accounts: [
    { address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
    { address: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", writable: true },
    { address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1" },
    { address: "HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY", writable: true },
    { address: "DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz", writable: true },
    { address: "HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz", writable: true },
    { address: "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX" },
    { address: "8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6", writable: true },
    { address: "5jWUncPNBMZJ3sTHKmMLszypVkoRK6bfEQMQUHweeQnh", writable: true },
    { address: "EaXdHx7x3mdGA38j5RSmKYSXMzAFzzUXCLNBEDXDn1d5", writable: true },
    { address: "8CvwxZ9Db6XbLD46NZwwmVDZZRDy7eydFcAGkXKh9axa", writable: true },
    { address: "CKxTHwM9fPMRRvZmFnFoqKNd9pQR21c5Aq9bh5h9oghX", writable: true },
    { address: "6A5NHCj1yF6urc9wZNe6Bcjj4LVszQNj5DwAWG97yzMu", writable: true },
    { address: "CTz5UMLQm2SRWHzQnU62Pi4yJqbNGjgRBHqqp6oDHfF7" },
  ],
};

/**
 * Orca Whirlpool SOL/USDC pool (highest-TVL, tick spacing 4). Orca resolves its
 * vaults + price-dependent tick arrays dynamically at build time, so the config
 * is just the pool + mints + amount. Mint order matches the whirlpool's on-chain
 * token_mint_a/b (A = WSOL).
 */
export const DEFAULT_ORCA_CONFIG = {
  poolAddress: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
  tokenAMint: WSOL,
  tokenBMint: USDC,
  swapAmountLamports: SWAP_AMOUNT_LAMPORTS,
};
