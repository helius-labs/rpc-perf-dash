"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Periodically re-pulls the server component data via router.refresh() so the
 * /status page stays live without a manual reload. Between refreshes the
 * <LiveAge> counters tick locally; each refresh resyncs their baseline to the
 * real heartbeat/sample timestamps. Default 20s matches the data cache TTL.
 */
export function AutoRefresh({ intervalMs = 20_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return null;
}
