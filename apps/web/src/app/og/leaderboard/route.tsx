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
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GEO_REGION_LABELS } from "@rpcbench/shared/types";
import { fetchRankedOverall, fetchRankedSingle } from "@/lib/leaderboard";
import { brandColorFor, colorFor, logoFor } from "@/lib/providerColors";
import { parseShareParams } from "@/lib/share";
import { siteDisplayHost } from "@/lib/siteUrl";
import { WINDOWS } from "@/lib/windows";
import { LeaderboardCard, type CardRow } from "../og-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIZE = { width: 1200, height: 630 } as const;

// Fonts are referenced relative to this module so the bundler emits + traces
// them (works in dev and in the production/standalone output, unlike a bare
// process.cwd() join into src/). The Node runtime can't fetch() a file:// URL,
// so resolve the traced asset to a path and read it off disk.
async function loadFonts() {
  const load = (file: string) =>
    fs.readFile(fileURLToPath(new URL(`../_fonts/${file}`, import.meta.url)));
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

// public/ ships with the deployment, so read the SVG marks off disk and inline
// them as data URIs (Satori only renders SVG via <img>). cwd is normally the
// app root (apps/web); fall back to the monorepo-rooted path just in case. A
// missing/unreadable logo returns null → the card draws an initial chip.
async function logoDataUri(providerId: string): Promise<string | null> {
  const url = logoFor(providerId);
  if (!url) return null;
  const rel = url.replace(/^\//, "");
  for (const base of [
    path.join(process.cwd(), "public", rel),
    path.join(process.cwd(), "apps/web/public", rel),
  ]) {
    try {
      const buf = await fs.readFile(base);
      return `data:image/svg+xml;base64,${buf.toString("base64")}`;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export async function GET(req: Request) {
  const filters = parseShareParams(new URL(req.url).searchParams);

  // Fetch the ranked field with the sharer's weights, then keep only eligible
  // providers (a real winner, not a 0-score placeholder).
  let rows: Omit<CardRow, "brand" | "color" | "logo">[] = [];
  if (filters.region === "overall") {
    const ranked = await fetchRankedOverall({
      windowHours: filters.windowHours,
      connectionMode: filters.mode,
      method: filters.method,
      weights: filters.weights,
    });
    rows = ranked
      .filter((r) => r.total > 0)
      .map((r) => ({
        provider_id: r.provider_id,
        provider_name: r.provider_name,
        total: r.total,
        p50_ms: r.p50_blend,
        win_rate: r.win_rate,
        eligible: true,
      }));
  } else {
    const ranked = await fetchRankedSingle({
      geoRegion: filters.region,
      windowHours: filters.windowHours,
      connectionMode: filters.mode,
      workerProvider: filters.infra,
      method: filters.method,
      weights: filters.weights,
    });
    rows = ranked
      .filter((r) => r.eligible)
      .map((r) => ({
        provider_id: r.provider_id,
        provider_name: r.provider_name,
        total: r.total,
        p50_ms: r.p50_ms,
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
      logo: await logoDataUri(r.provider_id),
    })),
  );

  const regionLabel =
    filters.region === "overall" ? "Overall (all regions)" : GEO_REGION_LABELS[filters.region];
  const windowLabel = WINDOWS.find((w) => w.value === filters.windowHours)?.label ?? `${filters.windowHours}h`;
  const contextLabel = `${filters.mode === "cold" ? "cold start" : "warm"} · last ${windowLabel}`;

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

  const fonts = await loadFonts();

  return new ImageResponse(
    (
      <LeaderboardCard
        rows={cardRows}
        method={filters.method}
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
