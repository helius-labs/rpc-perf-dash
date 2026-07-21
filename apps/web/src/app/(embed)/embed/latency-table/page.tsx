import {
  BENCHMARKED_PROVIDERS,
  WORKER_PROVIDER_LABELS,
  type Method,
} from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { parseShareParams } from "@/lib/share";
import { fetchActiveProviders } from "@/lib/leaderboard";
import { buildLatencyTableData } from "@/lib/embedData";
import {
  MethodRegionTabs,
  type InfraOption,
  type InfraTableData,
} from "@/components/MethodRegionTabs";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SearchParams {
  method?: string;
  window?: string;
}

const DEFAULT_METHOD: Method = "getTransaction";
const METHOD_SET = new Set<string>(ALL_METHODS);

/**
 * Embeddable per-method / per-region latency table (MethodRegionTabs). `window`
 * applies at fetch time; method / region / cold-warm / infra switching is
 * client-side inside the component (all infra data is pre-shipped), so `?method=`
 * only sets the initial view. Live data via the cached fetchers.
 */
export default async function EmbedLatencyTablePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = parseShareParams(params as Record<string, string | undefined>);
  const selectedMethod: Method =
    params.method && METHOD_SET.has(params.method) ? (params.method as Method) : DEFAULT_METHOD;

  const tableProviders = BENCHMARKED_PROVIDERS.map((p) => ({ id: p.id, name: p.name }));

  let byInfra: Record<string, InfraTableData> = {};
  let infraOptions: InfraOption[] = [{ id: "all", label: "All infra" }];
  let error: string | null = null;
  try {
    const activeProviders = await fetchActiveProviders();
    const infraKeys = ["all", ...activeProviders];
    infraOptions = [
      { id: "all", label: "All infra" },
      ...activeProviders.map((p) => ({ id: p, label: WORKER_PROVIDER_LABELS[p] ?? p })),
    ];
    byInfra = await buildLatencyTableData({
      infraKeys,
      windowHours: filters.windowHours,
      tableProviders,
    });
  } catch (err) {
    console.error("[embed/latency-table]", err);
    error = DB_ERROR_MESSAGE;
  }

  if (error) {
    return (
      <div className="badge bad" style={{ display: "block", padding: 12 }} role="alert">
        Latency table unavailable: {error}
      </div>
    );
  }

  return (
    <MethodRegionTabs
      providers={tableProviders}
      byInfra={byInfra}
      infraOptions={infraOptions}
      selectedMethod={selectedMethod}
      embed
    />
  );
}
