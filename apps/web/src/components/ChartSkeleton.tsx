/**
 * Pulsing chart-area skeleton — the loading placeholder for the plot itself
 * (no control bar). Shared by ChartLoading (server Suspense fallback for the
 * Performance/Overview chart) and the client-side latency-distribution loading
 * state, so both look identical.
 */
export function ChartSkeleton() {
  return (
    <div className="border border-line rounded-lg overflow-hidden" aria-busy="true" aria-label="Loading chart">
      <svg viewBox="0 0 1280 420" className="block w-full h-auto animate-pulse">
        {[80, 160, 240, 320].map((y) => (
          <line key={y} x1={56} x2={1264} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
        ))}
        <polyline
          points="56,300 240,260 430,285 620,210 810,250 1000,180 1190,205"
          fill="none"
          stroke="var(--border-2)"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points="56,350 240,330 430,345 620,300 810,330 1000,290 1190,310"
          fill="none"
          stroke="var(--border-2)"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.6}
        />
      </svg>
    </div>
  );
}
