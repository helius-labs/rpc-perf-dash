/**
 * GET /api/meta
 *
 * Everything an API consumer needs to build a valid /api/leaderboard query in a
 * single call: the constant enums (methods, regions, modes, windows), the
 * scoring config (weights, methodology version), the provider roster, and the
 * currently-active geos / infra / infra×geo pairs from recent heartbeats.
 *
 * No auth — pure public reference data. See /api-reference.
 */

import {
  GEO_REGIONS,
  METHODOLOGY_VERSION,
  BENCHMARKED_PROVIDERS,
} from "@rpcbench/shared";
import {
  DEFAULT_REGION_WEIGHTS,
  DEFAULT_WEIGHTS,
} from "@rpcbench/shared/scoring";
import {
  fetchActiveGeos,
  fetchActiveInfraGeo,
  fetchActiveProviders,
} from "@/lib/leaderboard";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";

export async function GET() {
  const [active_geos, active_infra, active_infra_geo] = await Promise.all([
    fetchActiveGeos(),
    fetchActiveProviders(),
    fetchActiveInfraGeo(),
  ]);

  const body = {
    methodology_version: METHODOLOGY_VERSION,
    weights: DEFAULT_WEIGHTS,
    region_weights: DEFAULT_REGION_WEIGHTS,
    methods: ALL_METHODS,
    geo_regions: GEO_REGIONS,
    connection_modes: ["cold", "warm"] as const,
    windows: WINDOWS,
    providers: BENCHMARKED_PROVIDERS.map((p) => ({ id: p.id, name: p.name })),
    active_geos,
    active_infra,
    active_infra_geo,
    generated_at: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
    },
  });
}
