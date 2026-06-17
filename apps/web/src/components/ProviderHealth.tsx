/**
 * Provider / infra / auditor health strip rendered above the main dashboard.
 *
 * Server-rendered. One pass per page load. Three sections:
 *   - Benchmarked: the panel that votes on correctness via consensus
 *   - Infra:       per-cloud vantage health
 *   - Auditor:     the independent utility-endpoint tripwire (consensus
 *                  cross-check) + the finality-verified consensus-accuracy
 *                  metric.
 *
 * Each card has a colored status dot, name, and a compact metric. Hovering
 * shows raw counts; clicking benchmarked rows goes to the per-provider
 * drilldown.
 */

import Link from "next/link";
import type { Route } from "next";
import { BENCHMARKED_PROVIDERS, providerSlug } from "@rpcbench/shared/providers";
import { WORKER_PROVIDER_LABELS } from "@rpcbench/shared";
import { statusForInfra, statusForBenchmarked } from "@/lib/fleetStatus";
import type {
  BenchmarkedHealth,
  AuditorHealth,
  InfraVantageHealth,
} from "@/lib/healthTypes";
import { Tooltip } from "./Tooltip";

interface Props {
  benchmarked: BenchmarkedHealth[];
  auditor: AuditorHealth;
  infra: InfraVantageHealth[];
  windowLabel: string;
}

type Status = "ok" | "degraded" | "down" | "absent";

// Status grading (benchmarked + per-vantage infra) lives in lib/fleetStatus.ts,
// shared with the header dot's /api/fleet-status route so the two can't drift.

const STATUS_COLOR: Record<Status, { dot: string; bg: string; label: string }> = {
  ok:       { dot: "#7be0a4", bg: "#0e2a18", label: "healthy" },
  degraded: { dot: "#f3c27a", bg: "#2a1f0e", label: "degraded" },
  down:     { dot: "#f08080", bg: "#2a1010", label: "down" },
  absent:   { dot: "#666",    bg: "#1a1a1a", label: "no samples" },
};

function fmtAge(t: string | Date | null): string {
  if (t == null) return "—";
  const ts = (typeof t === "string" ? new Date(t) : t).getTime();
  const dt = (Date.now() - ts) / 1000;
  if (dt < 60) return `${Math.max(1, Math.floor(dt))}s`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m`;
  return `${Math.floor(dt / 3600)}h`;
}

export function ProviderHealth({ benchmarked, auditor, infra, windowLabel }: Props) {
  // Order benchmarked by static config so the strip is stable across reloads.
  const benchOrdered = BENCHMARKED_PROVIDERS.filter((p) => p.benchmarked).map((p) => ({
    cfg: p,
    h: benchmarked.find((b) => b.provider_id === p.id) ?? {
      provider_id: p.id,
      n_samples: 0,
      n_correct: 0,
      p95_ms: null,
      latest: null,
    },
  }));

  const benchmarkedItems = benchOrdered.map(({ cfg, h }) => {
    const status = statusForBenchmarked(h);
    const c = STATUS_COLOR[status];
    const correctPct = h.n_samples > 0 ? (100 * h.n_correct) / h.n_samples : 0;
    return (
      <Card
        key={cfg.id}
        dotColor={c.dot}
        bg={c.bg}
        href={`/provider/${providerSlug(cfg)}`}
        title={`${cfg.name}: ${h.n_correct}/${h.n_samples} correct over last ${windowLabel} (status: ${c.label})`}
      >
        <span className="text-[11px] font-medium">{cfg.name}</span>
        <span className="text-[9px] text-muted">
          {h.n_samples === 0 ? "—" : `${correctPct.toFixed(0)}% · ${h.n_samples}n`}
        </span>
      </Card>
    );
  });

  const auditorItems = (() => {
    // There is intentionally no "Endpoint last OK" chip — utility_rpc_status
    // only records the *publisher's* last successful publish, not the auditor's
    // actual liveness from the deferred-finality job's POV, so it would read
    // "never" permanently and mislead. Liveness signal lives in the
    // Accuracy chip (a populated accuracy % implies the auditor is
    // answering) and the Consensus Integrity panel (auditor_unavailable
    // count).
    const accLabel =
      auditor.consensus_accuracy_pct === null
        ? "no audits yet"
        : `${auditor.consensus_accuracy_pct.toFixed(2)}% match (${auditor.consensus_audited_n.toLocaleString()} audited)`;
    return [
      <Card
        key="auditor-accuracy"
        dotColor={
          auditor.consensus_accuracy_pct === null
            ? STATUS_COLOR.absent.dot
            : auditor.consensus_accuracy_pct >= 99.5
              ? STATUS_COLOR.ok.dot
              : auditor.consensus_accuracy_pct >= 95
                ? STATUS_COLOR.degraded.dot
                : STATUS_COLOR.down.dot
        }
        bg={
          auditor.consensus_accuracy_pct === null
            ? STATUS_COLOR.absent.bg
            : auditor.consensus_accuracy_pct >= 99.5
              ? STATUS_COLOR.ok.bg
              : auditor.consensus_accuracy_pct >= 95
                ? STATUS_COLOR.degraded.bg
                : STATUS_COLOR.down.bg
        }
        title={`Consensus accuracy (finality-verified): ${accLabel}`}
      >
        <span className="text-[11px] font-medium">Accuracy</span>
        <span className="text-[9px] text-muted">{accLabel}</span>
      </Card>,
    ];
  })();

  const infraItems = buildInfraItems(infra);

  const benchmarkedTooltip = (
    <>
      <div className="font-medium mb-1.5">Benchmarked providers</div>
      <div className="text-neutral-300">
        The RPC providers under test. Each card shows the share of samples
        that returned a correct response, and the sample count, over the
        last {windowLabel}. Dot color reflects health (green = healthy,
        amber = degraded, red = down, gray = no samples yet). Click a card
        to drill into per-provider details.
      </div>
    </>
  );

  const infraTooltip = (
    <>
      <div className="font-medium mb-1.5">Infrastructure vantages</div>
      <div className="text-neutral-300">
        The cloud locations where worker agents run benchmarks from. Each
        card is one worker_provider (AWS, Cloudflare, TeraSwitch, …) and
        shows how many of its regional vantages are healthy. A vantage
        counts as healthy if it&apos;s heartbeating and producing samples
        within the last {windowLabel}. Tap a card for per-region detail.
      </div>
    </>
  );

  const auditorTooltip = (
    <>
      <div className="font-medium mb-1.5">Independent auditor</div>
      <div className="text-neutral-300">
        Correctness comes from majority consensus across the
        benchmarked panel. The auditor (utility endpoint) is a separate,
        panel-independent reference that <em>does not vote</em>. It&apos;s a
        tripwire: when consensus disagrees with the auditor, the challenge is
        marked <code>consensus_disputed</code> and excluded from scoring. The
        finality-verified accuracy below re-fetches a sample of finalized
        challenges and confirms the consensus answer matched canonical
        on-chain truth.
      </div>
    </>
  );

  return (
    <div className="bg-surface border border-line rounded-md mb-3">
      {/* Desktop: 2-column table (label · cards) */}
      <table className="hidden md:table w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[120px]" />
          <col />
        </colgroup>
        <tbody>
          <SectionRow
            label="Benchmarked"
            sublabel={`success/correct · ${windowLabel}`}
            tooltip={benchmarkedTooltip}
            items={benchmarkedItems}
          />
          <SectionRow
            label="Infra"
            sublabel={`vantages · ${windowLabel}`}
            tooltip={infraTooltip}
            items={infraItems}
          />
          <SectionRow
            label="Auditor"
            sublabel="independent tripwire"
            tooltip={auditorTooltip}
            items={auditorItems}
            last
          />
        </tbody>
      </table>

      {/* Mobile: stacked sections (label header on top, cards wrap below) */}
      <div className="md:hidden">
        <MobileSection
          label="Benchmarked"
          sublabel={`success/correct · ${windowLabel}`}
          tooltip={benchmarkedTooltip}
          items={benchmarkedItems}
        />
        <MobileSection
          label="Infra"
          sublabel={`vantages · ${windowLabel}`}
          tooltip={infraTooltip}
          items={infraItems}
        />
        <MobileSection
          label="Auditor"
          sublabel="independent tripwire"
          tooltip={auditorTooltip}
          items={auditorItems}
          last
        />
      </div>
    </div>
  );
}

function MobileSection({
  label,
  sublabel,
  tooltip,
  items,
  last,
}: {
  label: string;
  sublabel: string;
  tooltip: React.ReactNode;
  items: React.ReactNode[];
  last?: boolean;
}) {
  return (
    <div className={"px-2 py-1" + (last ? "" : " border-b border-line")}>
      <Tooltip title={label} trigger={
        <div className="inline-flex items-baseline gap-1 mb-[3px] cursor-help">
          <span className="text-[9px] text-fg2 uppercase tracking-[0.5px] font-semibold border-b border-dotted border-current">
            {label}
          </span>
          <span className="text-[8px] text-muted">{sublabel}</span>
        </div>
      }>
        {tooltip}
      </Tooltip>
      <div className="flex flex-wrap gap-[3px]">{items}</div>
    </div>
  );
}

/**
 * Build the per-provider Infra cards. Returns the React nodes only — caller
 * wraps them in whichever section shell fits the viewport.
 */
function buildInfraItems(infra: InfraVantageHealth[]): React.ReactNode[] {
  // Provider order: ones we've actually deployed first (AWS, CF, TSW), then
  // others. Within each provider, vantages sorted by region for stability.
  const PROVIDER_ORDER = ["aws", "cloudflare", "teraswitch", "gcp", "latitude", "hetzner"];

  const groups = new Map<string, InfraVantageHealth[]>();
  for (const i of infra) {
    const arr = groups.get(i.worker_provider) ?? [];
    arr.push(i);
    groups.set(i.worker_provider, arr);
  }
  const orderedProviders = [...groups.keys()].sort(
    (a, b) =>
      (PROVIDER_ORDER.indexOf(a) === -1 ? 999 : PROVIDER_ORDER.indexOf(a)) -
      (PROVIDER_ORDER.indexOf(b) === -1 ? 999 : PROVIDER_ORDER.indexOf(b)),
  );

  return orderedProviders.map((provider) => {
    const vantages = groups.get(provider)!.slice().sort((a, b) => a.region.localeCompare(b.region));
    const worst = worstInfraStatus(vantages);
    const c = STATUS_COLOR[worst];
    const okCount = vantages.filter(
      (v) => statusForInfra(v.staleness_s, v.n_samples_15m) === "ok",
    ).length;
    const providerName = WORKER_PROVIDER_LABELS[provider] ?? provider;

    return (
      <Tooltip
        key={provider}
        title={`${providerName} infra vantages`}
        trigger={
          <Card dotColor={c.dot} bg={c.bg}>
            <span className="text-[11px] font-medium">{providerName}</span>
            <span className="text-[9px] text-muted">
              {okCount}/{vantages.length} healthy
            </span>
          </Card>
        }
      >
        <div className="font-medium mb-1.5">
          {providerName} <span className="text-neutral-400">· {okCount}/{vantages.length} healthy</span>
        </div>
        <div className="flex flex-col gap-1">
          {vantages.map((v) => {
            const s = statusForInfra(v.staleness_s, v.n_samples_15m);
            const sc = STATUS_COLOR[s];
            const beatAge = v.beat_at ? fmtAge(v.beat_at) : "never";
            const samples = v.staleness_s === null ? "never beat" : `${v.n_samples_15m}n · ${beatAge}`;
            return (
              <div
                key={`${v.region}/${v.egress_path}`}
                className="flex items-center gap-2"
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: sc.dot, boxShadow: `0 0 4px ${sc.dot}55` }}
                />
                <span className="font-mono text-[11px] flex-1">{v.region}</span>
                <span className="text-neutral-400 text-[10px] tabular-nums">{samples}</span>
              </div>
            );
          })}
        </div>
      </Tooltip>
    );
  });
}

/** Worst-case status across a set of infra vantages — drives the card dot color. */
function worstInfraStatus(vantages: InfraVantageHealth[]): Status {
  const RANK: Record<Status, number> = { down: 3, degraded: 2, absent: 1, ok: 0 };
  let worst: Status = "ok";
  for (const v of vantages) {
    const s = statusForInfra(v.staleness_s, v.n_samples_15m);
    if (RANK[s] > RANK[worst]) worst = s;
  }
  return worst;
}

function SectionRow({
  label,
  sublabel,
  tooltip,
  items,
  last,
}: {
  label: string;
  sublabel: string;
  tooltip: React.ReactNode;
  items: React.ReactNode[];
  last?: boolean;
}) {
  const cellCls = "px-2 py-1.5 align-middle" + (last ? "" : " border-b border-line");
  return (
    <tr>
      <th
        scope="row"
        className={cellCls + " bg-bg border-r border-line text-left font-semibold"}
      >
        <Tooltip
          trigger={
            <span className="inline-block cursor-help">
              <span className="text-[10px] text-fg2 uppercase tracking-[0.5px] border-b border-dotted border-current">
                {label}
              </span>
              <span className="block text-[9px] text-muted font-normal">
                {sublabel}
              </span>
            </span>
          }
        >
          {tooltip}
        </Tooltip>
      </th>
      <td className={cellCls}>
        <div className="flex gap-1 flex-wrap">{items}</div>
      </td>
    </tr>
  );
}

function Card({
  dotColor,
  bg,
  href,
  title,
  children,
}: {
  dotColor: string;
  bg: string;
  href?: string;
  title?: string;
  children: React.ReactNode;
}) {
  // Only the status-driven colors stay inline (runtime values that can't be
  // static utilities): the card background, the dot color, and the dot glow.
  // Everything else — sizing, border, layout — is Tailwind.
  const inner = (
    <div
      className="flex items-center gap-1 md:gap-1.5 px-1 py-0.5 md:px-1.5 md:py-[3px] rounded min-w-[72px] md:min-w-[96px] border border-line"
      style={{ background: bg }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: dotColor, boxShadow: `0 0 4px ${dotColor}55` }}
      />
      <div className="flex flex-col leading-[1.15]">{children}</div>
    </div>
  );
  if (href) {
    return (
      <Link href={href as Route} title={title} className="no-underline text-inherit">
        {inner}
      </Link>
    );
  }
  return (
    <span title={title} className="inline-block">
      {inner}
    </span>
  );
}
