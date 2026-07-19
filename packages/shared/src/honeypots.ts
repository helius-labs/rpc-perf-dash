/**
 * Honeypot pool & selection.
 *
 * Honeypots are randomly sampled deeply-finalized history (slot range:
 * tip − 1000 epochs to tip − 10 epochs, drawn uniformly), with ground truth
 * fetched from the utility endpoint offline plus a manual operator
 * spot-check before the pool is trusted (see apps/generator/src/honeypot.ts)
 * — which is what makes expected_projection reliable.
 *
 * Indistinguishability requirement: pool is sampled uniformly at random.
 * Operator must not pick "interesting" cases (genesis block, popular signatures,
 * etc.) because providers could route those to a guaranteed-correct path.
 *
 * is_honeypot is hidden from worker queries via the challenges_worker_view.
 * Workers cannot tell honeypots from regular challenges at execution time.
 */


/** Target injection rate. Generator picks a honeypot vs a fresh challenge with this probability. */
export const HONEYPOT_INJECTION_RATE = 0.05;

/** Target pool size per method. */
export const HONEYPOT_POOL_TARGET_PER_METHOD = 2000;
