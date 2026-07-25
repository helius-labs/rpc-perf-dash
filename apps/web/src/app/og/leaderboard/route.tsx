/**
 * Share-card image route: GET /og/leaderboard?method=&region=&mode=&window=&infra=&preset=|w=
 *
 * Renders the 1200×630 Twitter card (next/og → Satori → resvg) reflecting the
 * exact filters + scoring weights the sharer saw. Used two ways: as the
 * twitter:image target on the host pages (so the link renders a card in-feed)
 * and as a direct PNG fetched by ShareButton's "Download image".
 *
 * runtime = nodejs: we read bundled fonts and the public SVG logos off disk and
 * call the DB-backed leaderboard fetchers.
 */

import { ImageResponse } from "next/og";
import { GEO_REGION_LABELS, GEO_REGIONS, type GeoRegion } from "@rpcbench/shared/types";
import { DEFAULT_REGION_WEIGHTS, type RegionWeights } from "@rpcbench/shared/scoring";
import { fetchRankedLatency, fetchRankedPreset } from "@/lib/leaderboard";
import { apiPath } from "@/lib/basePath";
import { brandColorFor, colorFor, logoFor } from "@/lib/providerColors";
import { parseShareParams } from "@/lib/share";
import { presetById } from "@/lib/workloadPresets";
import { siteDisplayHost } from "@/lib/siteUrl";
import { WINDOWS } from "@/lib/windows";
import { LeaderboardCard, type CardRow } from "../og-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIZE = { width: 1200, height: 630 } as const;

// Fonts + logos live in public/ and are fetched over the request origin. This
// is the one approach that works in both dev and the Vercel serverless function:
// import.meta.url bakes in the build-time source path (gone at runtime) and the
// function filesystem doesn't include public/, so neither fs nor a file:// URL
// works — but the assets are always reachable over HTTP from the same origin.
async function loadFonts(origin: string) {
  const load = (file: string) =>
    // public/ assets are served under the basePath — prefix so the fetch hits
    // /benchmarks/fonts/* rather than a 404 at the origin root. (logoFor already
    // returns basePath-prefixed paths, so the logo fetch needs no change.)
    fetch(new URL(apiPath(`/fonts/${file}`), origin)).then((r) => r.arrayBuffer());
  const [sansReg, sansMed, sansSemi, monoReg, monoMed] = await Promise.all([
    load("Geist-Regular.ttf"),
    load("Geist-Medium.ttf"),
    load("Geist-SemiBold.ttf"),
    load("GeistMono-Regular.ttf"),
    load("GeistMono-Medium.ttf"),
  ]);
  return [
    { name: "Geist", data: sansReg, weight: 400 as const, style: "normal" as const },
    { name: "Geist", data: sansMed, weight: 500 as const, style: "normal" as const },
    { name: "Geist", data: sansSemi, weight: 600 as const, style: "normal" as const },
    { name: "Geist Mono", data: monoReg, weight: 400 as const, style: "normal" as const },
    { name: "Geist Mono", data: monoMed, weight: 500 as const, style: "normal" as const },
  ];
}

// Inline each SVG mark as a base64 data URI (Satori only renders SVG via <img>).
// Fetched from public/ over the origin; a failed fetch returns null → initial chip.
async function logoDataUri(providerId: string, origin: string): Promise<string | null> {
  const url = logoFor(providerId);
  if (!url) return null;
  try {
    const res = await fetch(new URL(url, origin));
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:image/svg+xml;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const filters = parseShareParams(new URL(req.url).searchParams);

  // Latency card requires a SINGLE method (a ms number is meaningless blended
  // across methods). The ShareButton only offers it with one method selected,
  // but a hand-crafted / legacy URL could set metric=latency without methods=
  // (→ the preset's full method set), so we guard here and fall back to the
  // score card unless exactly one method is present.
  const latencyMode = filters.metric === "latency" && filters.methods.length === 1;
  const preset = presetById(filters.presetId);

  let rows: Omit<CardRow, "brand" | "color" | "logo">[];
  if (latencyMode) {
    // Rank providers by the chosen percentile (ascending — fastest first) for
    // the single method + connection mode, pooled across the selected regions.
    const method = filters.methods[0]!;
    const statKey = filters.stat === "p95" ? "p95" : "p50";
    // Normalize regions before the cache boundary so caller order doesn't
    // fragment the unstable_cache key (the cached fn keys on this raw argument).
    const regions = [...new Set(filters.regions)].sort();
    const lat = await fetchRankedLatency({
      method,
      mode: filters.mode,
      regions,
      windowHours: filters.windowHours,
      ...(filters.infra ? { workerProvider: filters.infra } : {}),
    });
    rows = lat
      .filter((r) => r[statKey] != null)
      .sort((a, b) => (a[statKey] as number) - (b[statKey] as number))
      .map((r) => ({
        provider_id: r.provider_id,
        provider_name: r.provider_name,
        total: 0, // placeholder — the latency branch of the card never reads it
        p50_ms: r.p50,
        p95_ms: r.p95,
        win_rate: 0, // placeholder — see above
        eligible: true,
      }));
  } else {
    // One unified blend path: the exact board the sharer saw (homepage preset or
    // /performance method selection), via fetchRankedPreset with the decoded
    // overrides. The board is a method-blend, so no single latency percentile is
    // meaningful — p50 is omitted (matches the on-screen ScoreStrip).
    const regionWeights: Partial<RegionWeights> = Object.fromEntries(
      filters.regions.map((g) => [g, DEFAULT_REGION_WEIGHTS[g] ?? 0.1]),
    );
    const ranked = await fetchRankedPreset({
      presetId: filters.presetId,
      methods: filters.methods,
      methodWeights: filters.methodWeights,
      regionWeights,
      componentWeights: filters.weights,
      windowHours: filters.windowHours,
      connectionMode: filters.mode,
      ...(filters.infra ? { workerProvider: filters.infra } : {}),
    });
    rows = ranked
      .filter((r) => r.coverage_ok && r.total > 0)
      .map((r) => ({
        provider_id: r.provider_id,
        provider_name: r.provider_name,
        total: r.total,
        p50_ms: null,
        p95_ms: null,
        win_rate: r.win_rate,
        eligible: true,
      }));
  }

  // Attach brand color / chart color / logo data URI per row.
  const cardRows: CardRow[] = await Promise.all(
    rows.slice(0, 5).map(async (r) => ({
      ...r,
      brand: brandColorFor(r.provider_id),
      color: colorFor(r.provider_id),
      logo: await logoDataUri(r.provider_id, origin),
    })),
  );

  // Labels. Header = preset label for a clean preset board; the method name for
  // a single custom method; else "Custom". A methods line lists the set (names
  // if few, else count) unless the header already names a single method.
  const presetMethodSet = new Set<string>(preset.methods);
  const isPresetMethods =
    filters.methods.length === presetMethodSet.size &&
    filters.methods.every((m) => presetMethodSet.has(m));
  const methodHeader = latencyMode
    ? filters.methods[0]! // latency card always names its single method
    : isPresetMethods
      ? preset.label
      : filters.methods.length === 1
        ? filters.methods[0]!
        : "Custom";
  const methodsLabel =
    filters.methods.length === 1
      ? undefined
      : filters.methods.length <= 6
        ? filters.methods.join(", ")
        : `${filters.methods.length} methods`;
  const regionLabel =
    filters.regions.length >= GEO_REGIONS.length
      ? "all regions"
      : filters.regions.length === 1
        ? GEO_REGION_LABELS[filters.regions[0] as GeoRegion]
        : `${filters.regions.length} regions`;
  const windowLabel = WINDOWS.find((w) => w.value === filters.windowHours)?.label ?? `${filters.windowHours}h`;
  const statLabel = filters.stat === "p95" ? "p95" : "p50";
  const contextLabel = `${latencyMode ? `${statLabel} · ` : ""}${filters.mode === "cold" ? "cold start" : "warm"} · last ${windowLabel}`;

  // Timestamp: "AS OF JUN 16 2026 · 14:30 UTC" in UTC.
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(now)
    .toUpperCase();
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(now);
  const timestamp = `AS OF ${date} · ${time} UTC`;

  const fonts = await loadFonts(origin);

  return new ImageResponse(
    (
      <LeaderboardCard
        rows={cardRows}
        metric={latencyMode ? "latency" : "score"}
        stat={filters.stat ?? "p50"}
        method={methodHeader}
        {...(methodsLabel ? { methodsLabel } : {})}
        regionLabel={regionLabel}
        contextLabel={contextLabel}
        timestamp={timestamp}
        siteUrl={siteDisplayHost()}
      />
    ),
    {
      ...SIZE,
      fonts,
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
      },
    },
  );
}
