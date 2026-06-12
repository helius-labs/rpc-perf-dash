"use client";

/**
 * Live, smoothly-rolling sample counter. Renders the server's initial total
 * immediately (no flash), then ticks up continuously by extrapolating at
 * `ratePerSec`, and re-syncs against /api/sample-count every ~30s. The number
 * only ever rolls up — on re-sync we never drop below what's already shown.
 */

import { useEffect, useRef, useState } from "react";
import type { SampleCount } from "@/lib/sampleCount";

const DISPLAY_FPS_MS = 50; // ~20fps — smooth roll without thrashing React
const RESYNC_MS = 30_000;

export function LiveSampleCounter({ initial }: { initial: SampleCount }) {
  const [display, setDisplay] = useState(initial.total);
  // Extrapolation anchor: displayed = total + rate * (now - t).
  const baseRef = useRef<{ total: number; rate: number; t: number }>({
    total: initial.total,
    rate: initial.ratePerSec,
    t: 0,
  });

  const currentValue = () => {
    const { total, rate, t } = baseRef.current;
    return total + rate * ((performance.now() - t) / 1000);
  };

  // Continuous roll.
  useEffect(() => {
    baseRef.current = { total: initial.total, rate: initial.ratePerSec, t: performance.now() };
    const id = setInterval(() => setDisplay(Math.floor(currentValue())), DISPLAY_FPS_MS);
    return () => clearInterval(id);
  }, [initial.total, initial.ratePerSec]);

  // Periodic re-sync — adopt the fresh total/rate, but never roll backward.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/sample-count", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as SampleCount;
        if (cancelled || !(d.total > 0)) return;
        baseRef.current = {
          total: Math.max(d.total, currentValue()),
          rate: d.ratePerSec ?? baseRef.current.rate,
          t: performance.now(),
        };
      } catch {
        // ignore — keep extrapolating from the last good anchor
      }
    };
    const id = setInterval(poll, RESYNC_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <span className="text-[26px] font-semibold tabular-nums leading-none text-fg">
      {display.toLocaleString()}
    </span>
  );
}
