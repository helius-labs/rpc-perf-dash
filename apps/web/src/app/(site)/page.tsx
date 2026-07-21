import Link from "next/link";
import type { Metadata, Route } from "next";
import { WINDOWS } from "@/lib/windows";
import { ogImagePath, parseShareParams } from "@/lib/share";
import { presetById } from "@/lib/workloadPresets";
import { type MethodRegionLatency } from "@/components/IndexLeaderboard";
import { type MethodGeoRows } from "@/components/leaderboardShared";
import { OverviewBoard } from "@/components/OverviewBoard";
import { buildOverviewBoardData } from "@/lib/embedData";
import { EMPTY_SAMPLE_COUNT, type SampleCount } from "@/lib/sampleCount";
import { fetchConsensusHealth } from "@/lib/health";
import { ConsensusBanner } from "@/components/ConsensusBanner";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SearchParams {
  window?: string;
  preset?: string;
}

// Per-view social card: reads the same filters the ShareButton encodes so a
// tweeted link renders the matching preset leaderboard card in-feed.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const params = await searchParams;
  const filters = parseShareParams(params as Record<string, string | undefined>);
  const preset = presetById(filters.presetId);
  const windowLabel =
    WINDOWS.find((w) => w.value === filters.windowHours)?.label ?? `${filters.windowHours}h`;
  const title = `Solana RPC Benchmark — ${preset.label} leaderboard`;
  const description = `Live, regional, non-gameable Solana RPC rankings for the ${preset.label} workload (last ${windowLabel}).`;
  const image = ogImagePath(filters);
  return {
    title,
    description,
    openGraph: { title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const windowHours = WINDOWS.some((w) => w.value === parseInt(params.window ?? "", 10))
    ? parseInt(params.window!, 10)
    : 24;

  const preset = presetById(params.preset);

  let cube: MethodGeoRows[] = [];
  let methodRegionLatency: MethodRegionLatency = {};
  let sampleCount: SampleCount = EMPTY_SAMPLE_COUNT;
  let methodCount = 0;
  let error: string | null = null;

  try {
    ({ cube, methodRegionLatency, sampleCount, methodCount } =
      await buildOverviewBoardData(windowHours));
  } catch (err) {
    console.error("[/]", err);
    error = DB_ERROR_MESSAGE;
  }

  // Consensus banner: warns (with the per-provider reason) when the panel has
  // dropped below the consensus minimum, so a provider going out of credits /
  // down is obvious instead of silently emptying the rankings. Self-fetched
  // (cached 30s, resilient) so it never breaks the page.
  const consensusHealth = await fetchConsensusHealth();

  return (
    <div>
      <ConsensusBanner data={consensusHealth} />
      {error && (
        <div className="badge bad" style={{ display: "block", padding: 12, marginBottom: 16 }}>
          DB error: {error}
        </div>
      )}

      {/* Intro + preset chips + leaderboard. The only control is the workload
          preset (a ?preset= navigation); all weight/region tuning lives on
          /performance. */}
      <OverviewBoard
        cube={cube}
        presetId={preset.id}
        methodRegionLatency={methodRegionLatency}
        sampleCount={sampleCount}
        methodCount={methodCount}
      />

      {/* Deep-dive CTA into /performance. */}
      <section className="mt-6 flex justify-end">
        <Link
          href={"/performance" as Route}
          className="group inline-flex items-center gap-2 rounded-full border border-accent/40 px-4 py-[8px] text-[13px] font-medium text-accent transition-colors hover:bg-accent/10 hover:border-accent hover:no-underline"
        >
          Full performance details
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
            <path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </section>
    </div>
  );
}
