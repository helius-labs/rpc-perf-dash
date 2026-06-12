"use client";

/**
 * Client-side fleet-status poller shared by the header status pill
 * (HeaderStatus) and the mobile drawer's Status row (MobileMenu). Fetches
 * /api/fleet-status after mount and re-polls; returns null until the first
 * response lands. The route is edge-cached, so the duplicate poll when both
 * components are mounted is one cheap cached GET.
 */

import { useEffect, useState } from "react";
import { FLEET_DOT, type FleetStatus } from "@/lib/fleetStatus";

const REFRESH_MS = 60_000;

export function useFleetStatus(): FleetStatus | null {
  const [status, setStatus] = useState<FleetStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/fleet-status", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { status: FleetStatus };
        if (!cancelled && d.status in FLEET_DOT) setStatus(d.status);
      } catch {
        // keep the last known status
      }
    };
    poll();
    const id = setInterval(poll, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return status;
}
