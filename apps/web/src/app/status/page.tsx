import { Suspense } from "react";
import { fetchPipelineStatus } from "@/lib/status";
import {
  PipelineStatusView,
  StatusTimelineSection,
  StatusTimelineSkeleton,
  StatusHealthSections,
  StatusHealthSkeleton,
} from "@/components/PipelineStatus";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Pipeline status · Solana RPC Benchmark",
  description: "Live health of the benchmark pipeline: generator, dispatch, workers, samples.",
};

export default async function StatusPage() {
  const data = await fetchPipelineStatus();
  return (
    <div>
      <AutoRefresh />
      <header className="status-header">
        <h1 className="status-title">Pipeline status</h1>
      </header>
      <PipelineStatusView data={data} />
      {/* The 24h timeline is the one heavy scan — stream it so the live funnel
          + cloud matrix above paint immediately. */}
      <Suspense fallback={<StatusTimelineSkeleton />}>
        <StatusTimelineSection />
      </Suspense>
      {/* Fleet health + consensus integrity (the last section). Streamed too,
          so the live funnel + cloud matrix above never wait on them. */}
      <Suspense fallback={<StatusHealthSkeleton />}>
        <StatusHealthSections />
      </Suspense>
    </div>
  );
}
