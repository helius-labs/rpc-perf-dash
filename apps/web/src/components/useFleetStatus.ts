"use client";

/**
 * Client-side fleet-status poller shared by the header status pill
 * (HeaderStatus) and the mobile drawer's Status row (MobileMenu). Fetches
 * /api/fleet-status after mount and re-polls; returns null until the first
 * response lands. The route is edge-cached, so the duplicate poll when both
 * components are mounted is one cheap cached GET.
 */

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/basePath";
import { FLEET_DOT, type FleetSummary } from "@/lib/fleetStatus";

const REFRESH_MS = 60_000;

export function useFleetStatus(): FleetSummary | null {
  const [summary, setSummary] = useState<FleetSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch(apiPath("/api/fleet-status"), { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as FleetSummary;
        if (!cancelled && d.status in FLEET_DOT) setSummary(d);
      } catch {
        // keep the last known summary
      }
    };
    poll();
    const id = setInterval(poll, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return summary;
}
