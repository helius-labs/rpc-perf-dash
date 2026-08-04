/**
 * Per-vendor regional POP routing.
 *
 * Each vantage sends to its NEAREST POP so the `region` axis stays clean — a
 * global/auto-routing endpoint would confound it. But every vendor names its
 * POPs differently ({region} for Helius, its own codes for the relays), so this
 * is a per-vendor `WORKER_REGION → POP` map, not one global map. A
 * `SendTargetConfig.url` may contain a `{region}` token that `applyRegion`
 * fills from the worker's region via the vendor's map.
 */

import type { SendTargetId } from "@rpcbench/shared";

/**
 * Map a fleet `WORKER_REGION` (cloud region code, e.g. `us-east-2`,
 * `europe-west3`, `ewr`) to a vendor POP code. Each vendor has its own set;
 * an unmapped region falls back to `default`.
 *
 * NOTE: the POP codes below cover the common vantages; extend per vendor as the
 * fleet grows. Helius Sender POPs: slc/ewr/lon/fra/ams/sg/tyo.
 */
type PopMap = Readonly<Record<string, string>> & { default: string };

const HELIUS_POPS: PopMap = {
  "us-east-2": "ewr",
  "us-east-1": "ewr",
  "us-west-2": "slc",
  "us-west-1": "slc",
  "europe-west3": "fra",
  "europe-west2": "lon",
  "europe-west4": "ams",
  "eu-central-1": "fra",
  "eu-west-2": "lon",
  "ap-northeast-1": "tyo",
  "ap-southeast-1": "sg",
  ewr: "ewr",
  slc: "slc",
  default: "ewr",
};

/**
 * Region maps per vendor. Vendors whose seeded URL is already region-fixed per
 * deployment (no `{region}` token) don't need a map — `applyRegion` is a no-op
 * when there's no token. Helius Sender is the primary templated case.
 */
const VENDOR_POPS: Partial<Record<SendTargetId, PopMap>> = {
  helius: HELIUS_POPS,
};

/** Resolve the POP code for a target + worker region (or null if no map). */
export function popFor(target: SendTargetId, workerRegion: string): string | null {
  const map = VENDOR_POPS[target];
  if (!map) return null;
  return map[workerRegion] ?? map.default;
}

/**
 * Fill a `{region}` token in a URL with the vendor's POP for this worker region.
 * URLs with no token are returned unchanged (region-fixed-per-deploy vendors).
 */
export function applyRegion(
  url: string,
  target: SendTargetId,
  workerRegion: string,
): string {
  if (!url.includes("{region}")) return url;
  const pop = popFor(target, workerRegion);
  if (!pop) {
    throw new Error(
      `send/region: ${target} url has a {region} token but no POP map for region ${workerRegion}`,
    );
  }
  return url.replaceAll("{region}", pop);
}
