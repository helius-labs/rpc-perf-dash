import {
  type PipelineStatus,
  type StageState,
  type TimelinePoint,
  humanizeAge,
  brokeAtUtc,
  fetchTimeline,
} from "@/lib/status";
import { LiveAge } from "@/components/LiveAge";

const STATE_LABEL: Record<StageState, string> = {
  ok: "Healthy",
  warn: "Degraded",
  down: "Down",
  unknown: "Unknown",
};
const STATE_BADGE: Record<StageState, string> = {
  ok: "good",
  warn: "warn",
  down: "bad",
  unknown: "",
};
const STATE_COLOR: Record<StageState, string> = {
  ok: "#6bf08c",
  warn: "#ffb84d",
  down: "#ff6b6b",
  unknown: "#6E6D67",
};

/** Inline SVG sparkline. Bars so empty (zero) buckets read as gaps at a glance. */
function Sparkline({
  values,
  color,
  width = 520,
  height = 34,
}: {
  values: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  const max = Math.max(1, ...values);
  const n = values.length;
  const bw = width / n;
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="status-spark">
      {values.map((v, i) => {
        const h = v === 0 ? 1 : Math.max(1, (v / max) * (height - 2));
        return (
          <rect
            key={i}
            x={i * bw}
            y={height - h}
            width={Math.max(0.5, bw - 0.5)}
            height={h}
            fill={v === 0 ? "#2a0a0a" : color}
            opacity={v === 0 ? 1 : 0.85}
          />
        );
      })}
    </svg>
  );
}

function StatusDot({ state }: { state: StageState }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: "50%",
        background: STATE_COLOR[state],
        boxShadow: state === "down" ? "0 0 6px #ff6b6b" : undefined,
      }}
    />
  );
}

export function PipelineStatusView({ data }: { data: PipelineStatus }) {
  return (
    <div className="status-page">
      {/* Overall banner */}
      <div className={`status-banner status-${data.overall}`}>
        <StatusDot state={data.overall} />
        <span className="status-banner-text">
          {data.overall === "ok"
            ? "All systems operational"
            : data.overall === "down"
              ? "Pipeline broken: see the first red stage below"
              : "Degraded: investigate below"}
        </span>
        <span className="status-banner-time">
          as of {data.generatedAtIso.replace("T", " ").slice(0, 19)} UTC · auto-refreshes
        </span>
      </div>

      {/* Funnel */}
      <section className="prov-section">
        <div className="prov-section-head">
          <span className="section-kicker">Pipeline funnel · live</span>
          <span className="prov-section-count">first red stage = broken link</span>
        </div>
        <ol className="status-funnel">
          {data.stages.map((s, i) => {
            const broken = s.state === "down" || s.state === "warn";
            return (
              <li key={s.key} className={`status-stage status-${s.state}`}>
                <span className="status-stage-rail">
                  <StatusDot state={s.state} />
                  {i < data.stages.length - 1 && <span className="status-stage-line" />}
                </span>
                <div className="status-stage-body">
                  <div className="status-stage-top">
                    <span className="status-stage-label">{s.label}</span>
                    <span className={`badge ${STATE_BADGE[s.state]}`}>{STATE_LABEL[s.state]}</span>
                    <span className="status-stage-metric">{s.metric}</span>
                  </div>
                  <div className="status-stage-detail">{s.detail}</div>
                  {broken && s.lastSeenAgeS != null && (
                    <div className="status-stage-broke">
                      last produced <strong>{humanizeAge(s.lastSeenAgeS)} ago</strong>
                      {", broke around "}
                      <code>{brokeAtUtc(data.generatedAtIso, s.lastSeenAgeS)}</code>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {data.auditorUnavailPct != null && (
          <div className="status-aux">
            Auditor coverage (last 15m):{" "}
            <strong>{(100 - data.auditorUnavailPct).toFixed(1)}%</strong> cross-checked
            {data.auditorUnavailPct > 0 && (
              <span className="status-aux-muted"> · {data.auditorUnavailPct}% auditor-unavailable</span>
            )}
          </div>
        )}
      </section>

      {/* Per-cloud matrix */}
      <section className="prov-section">
        <div className="prov-section-head">
          <span className="section-kicker">Per-cloud · 5m</span>
          <span className="prov-section-count">all clouds at once = shared cause</span>
        </div>
        <div className="prov-table-wrap is-scroll">
          <table className="prov-table">
            <thead>
              <tr>
                <th>Cloud</th>
                <th className="prov-num">Workers</th>
                <th className="prov-num">Heartbeat</th>
                <th className="prov-num">Claimed/min</th>
                <th className="prov-num">Samples/min</th>
                <th className="prov-num">Last sample</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {data.clouds.length === 0 ? (
                <tr><td colSpan={7} className="prov-empty">No clouds heartbeating in the last 30m.</td></tr>
              ) : (
                data.clouds.map((c) => (
                  <tr key={c.worker_provider}>
                    <td><StatusDot state={c.state} /> {c.label}</td>
                    <td className="prov-num">{c.nWorkers}</td>
                    <td className="prov-num"><LiveAge iso={c.lastBeatIso} /></td>
                    <td className="prov-num">{(c.claimed5m / 5).toFixed(0)}</td>
                    <td className="prov-num">{(c.sampled5m / 5).toFixed(0)}</td>
                    <td className="prov-num"><LiveAge iso={c.lastSampleIso} fallback=">2h" /></td>
                    <td><span className={`badge ${STATE_BADGE[c.state]}`}>{STATE_LABEL[c.state]}</span></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="status-aux status-aux-muted">
          “Claiming but no samples” (amber) is the silent-failure signature: workers alive but the
          claim→sample step producing nothing.
        </div>
      </section>
    </div>
  );
}

/**
 * 24h throughput sparklines. Split out of PipelineStatusView so the live funnel +
 * cloud matrix paint immediately while this — the one unavoidable long scan —
 * streams in behind a Suspense boundary (see StatusTimelineSection). Pure render
 * over the already-fetched timeline points.
 */
export function StatusTimeline({ timeline }: { timeline: TimelinePoint[] }) {
  const series: Array<{
    key: keyof Pick<TimelinePoint, "dispatched" | "claimed" | "sampled">;
    label: string;
    color: string;
  }> = [
    { key: "dispatched", label: "Dispatched", color: "#7aa2f7" },
    { key: "claimed", label: "Claimed", color: "#bb9af7" },
    { key: "sampled", label: "Sampled", color: "#6bf08c" },
  ];
  return (
    <section className="prov-section">
      <div className="prov-section-head">
        <span className="section-kicker">Throughput · 24h</span>
        <span className="prov-section-count">15-min buckets · red = empty</span>
      </div>
      <div className="status-spark-grid">
        {series.map((sgroup) => {
          const values = timeline.map((t) => t[sgroup.key]);
          const total = values.reduce((a, b) => a + b, 0);
          return (
            <div key={sgroup.key} className="status-spark-row">
              <div className="status-spark-meta">
                <span style={{ color: sgroup.color }}>●</span> {sgroup.label}
                <span className="status-aux-muted"> · {total.toLocaleString()} in 24h</span>
              </div>
              <Sparkline values={values} color={sgroup.color} />
            </div>
          );
        })}
      </div>
      <div className="status-spark-axis">
        <span>{timeline[0]?.label ?? ""}</span>
        <span>{timeline[timeline.length - 1]?.label ?? "now"}</span>
      </div>
    </section>
  );
}

/** Async server child: fetches the 60s-cached timeline, rendered inside a
 *  <Suspense> on /status so it never blocks the live sections. */
export async function StatusTimelineSection() {
  const timeline = await fetchTimeline();
  return <StatusTimeline timeline={timeline} />;
}

/** Suspense fallback for the timeline while it streams. */
export function StatusTimelineSkeleton() {
  return (
    <section className="prov-section" aria-busy="true">
      <div className="prov-section-head">
        <span className="section-kicker">Throughput · 24h</span>
        <span className="prov-section-count">loading…</span>
      </div>
      <div className="status-spark-grid">
        {["Dispatched", "Claimed", "Sampled"].map((label) => (
          <div key={label} className="status-spark-row">
            <div className="status-spark-meta">{label}</div>
            <svg width="100%" viewBox="0 0 520 34" preserveAspectRatio="none" className="status-spark animate-pulse">
              <rect x={0} y={10} width={520} height={20} fill="var(--border, #1f1f1f)" opacity={0.5} />
            </svg>
          </div>
        ))}
      </div>
    </section>
  );
}
