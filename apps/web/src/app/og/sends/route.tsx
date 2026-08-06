/**
 * Share-card image route: GET /og/sends?sw=<r>-<l>
 *
 * The sends analogue of /og/leaderboard — renders the same 1200×630 card
 * (LeaderboardCard) for the transaction-landing board, so a shared sends link
 * gets a card that matches the RPC one. `sw` carries the tuned weights so the
 * card reflects exactly what the sharer saw; absent → Balanced defaults.
 *
 * runtime = nodejs: reads bundled fonts + public logos off the origin and calls
 * the DB-backed send board fetcher.
 */

import { ImageResponse } from "next/og";
import {
  scoreSends,
  DEFAULT_SEND_WEIGHTS,
  type SendScoringWeights,
  type SendTargetMetrics,
} from "@rpcbench/shared/sendScoring";
import { fetchSendBoard } from "@/lib/sends";
import { apiPath } from "@/lib/basePath";
import { brandColorFor, colorFor, logoFor } from "@/lib/providerColors";
import { targetLabel } from "@/lib/sendLabels";
import { siteDisplayHost } from "@/lib/siteUrl";
import { LeaderboardCard, type CardRow } from "../og-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIZE = { width: 1200, height: 630 } as const;

async function loadFonts(origin: string) {
  const load = (file: string) =>
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

/** Inline a logo as a data URI — MIME by extension (send relays use png/jpg,
 *  read providers svg). Satori renders images only via <img> data URIs. */
async function logoDataUri(providerId: string, origin: string): Promise<string | null> {
  const url = logoFor(providerId);
  if (!url) return null;
  const ext = url.split("?")[0]!.split(".").pop()?.toLowerCase();
  const mime = ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : null;
  if (!mime) return null;
  try {
    const res = await fetch(new URL(url, origin));
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function parseWeights(s: string | null): SendScoringWeights {
  if (!s) return DEFAULT_SEND_WEIGHTS;
  const p = s.split("-").map(Number);
  if (p.length !== 2 || p.some((n) => !Number.isFinite(n) || n < 0)) return DEFAULT_SEND_WEIGHTS;
  return { reliability: p[0]! / 100, latency: p[1]! / 100 };
}

/** Which preset (if any) the weights equal → the card's title label. */
function presetLabel(w: SendScoringWeights): string {
  const eq = (a: SendScoringWeights) => a.reliability === w.reliability && a.latency === w.latency;
  if (eq(DEFAULT_SEND_WEIGHTS)) return "Balanced";
  if (eq({ reliability: 0.8, latency: 0.2 })) return "Reliability";
  if (eq({ reliability: 0.3, latency: 0.7 })) return "Latency";
  return "Custom";
}

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const weights = parseWeights(new URL(req.url).searchParams.get("sw"));

  const board = await fetchSendBoard("1d").catch(() => []);
  // Re-score with the shared weights + rank (same as the client board).
  const metrics: SendTargetMetrics[] = board.map((r) => ({
    send_target: r.send_target,
    landing_rate: r.landing_rate,
    // null (nothing landed) passes through — no latency credit, not 0 slots.
    slot_latency_p50: r.slot_latency_p50,
    slot_latency_p95: r.slot_latency_p95,
  }));
  const scored = new Map(scoreSends(metrics, weights).map((s) => [s.send_target, s]));
  const ranked = board
    .map((r) => ({ r, total: scored.get(r.send_target)?.total ?? r.total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const cardRows: CardRow[] = await Promise.all(
    ranked.map(async ({ r, total }) => {
      const slot = r.slot_latency_p50 == null ? "—" : `${Math.round(r.slot_latency_p50)} slot`;
      const name = targetLabel(r.send_target);
      return {
        provider_id: r.send_target,
        provider_name: name,
        total,
        p50_ms: null,
        p95_ms: null,
        win_rate: 0,
        brand: brandColorFor(r.send_target),
        color: colorFor(r.send_target),
        logo: await logoDataUri(r.send_target, origin),
        eligible: true,
        subtitle: `${(r.landing_rate * 100).toFixed(0)}% land · ${slot}`,
      };
    }),
  );

  const now = new Date();
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(now)
    .toUpperCase();
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(now);
  const timestamp = `AS OF ${date} · ${time} UTC`;

  const fonts = await loadFonts(origin);

  return new ImageResponse(
    (
      <LeaderboardCard
        rows={cardRows}
        metric="score"
        method="Transaction landing"
        methodsLabel={`${presetLabel(weights)} · landing rate + slot latency`}
        regionLabel="all regions"
        contextLabel="landing · last 24h"
        timestamp={timestamp}
        siteUrl={siteDisplayHost()}
      />
    ),
    {
      ...SIZE,
      fonts,
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
    },
  );
}
