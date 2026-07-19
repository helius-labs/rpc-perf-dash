"use client";

import { useEffect, useState } from "react";

/** Humanize a second count → "3s", "4m", "2h 10m". Kept local so this client
 *  component doesn't import the server-only lib/status module. */
function humanize(seconds: number): string {
  if (seconds < 0) seconds = 0;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/**
 * Renders the age of an absolute timestamp and ticks it every second so the
 * Per-cloud table's "Heartbeat / Last sample … ago" columns update live. The
 * baseline timestamp is re-supplied by the periodic server refresh
 * (see <AutoRefresh>), so the counter tracks reality instead of drifting.
 */
export function LiveAge({
  iso,
  suffix = " ago",
  fallback = "—",
}: {
  iso: string | null;
  suffix?: string;
  fallback?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return <>{fallback}</>;
  const ageS = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  return (
    <>
      {humanize(ageS)}
      {suffix}
    </>
  );
}
