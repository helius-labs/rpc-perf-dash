"use client";

/**
 * Interactive cost comparator. Holds the basket in React state and recomputes
 * costs entirely client-side via the pure engine on every edit — no API/server
 * round-trips, and the address bar stays clean (just /costs) while you work.
 * State is seeded from the URL on load so a shared link still opens to the right
 * basket; sharing is an explicit "Copy link" action rather than rewriting the
 * URL on every keystroke.
 *
 * Layout is results-first: compact controls (workload chips + a live volume
 * slider + segmented toggles), then the comparison as big ranked cards (cheapest
 * = leader, like the leaderboard), then collapsible fine-tune editors.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { Method } from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { Tooltip } from "@/components/Tooltip";
import { FloatingTooltip } from "@/components/FloatingTooltip";
import { brandColorFor, logoFor } from "@/lib/providerColors";
import { toCSV, triggerDownload } from "@/lib/exportData";
import { simulate, SECONDS_PER_MONTH, DEFAULT_PEAK_MULTIPLIER } from "@/lib/pricing/simulate";
import { plansForProvider } from "@/lib/pricing/plans.data";
import { streamingForProvider } from "@/lib/pricing/streaming.data";
import { PRESET_OPTIONS, DEFAULT_MONTHLY_CALLS, basketFromProfile } from "@/lib/pricing/presets";
import { encodeBasket, MAX_BYTES_PER_CALL } from "@/lib/pricing/basket";
import type { Basket, ProviderCostResult, StreamKind, StreamingUsage } from "@/lib/pricing/types";

type View = "rpc" | "streaming" | "both";
type Basis = "plan" | "marginal";
type DisplayMode = "usd" | "units";

// gRPC is one product class branded per provider (Helius = LaserStream, others =
// Geyser); the engine prices "geyser" and "laserstream" as synonyms, so the usage
// UI uses a single canonical "geyser" card rather than two redundant ones.
const STREAM_KINDS: { kind: StreamKind; label: string }[] = [
  { kind: "geyser", label: "gRPC (Geyser / LaserStream)" },
  { kind: "websocket", label: "WebSocket" },
  { kind: "webhook", label: "Webhooks" },
];

const STREAM_AXES: {
  key: keyof StreamingUsage;
  label: string;
  unit: string;
  hint: string;
  minLog: number;
  maxLog: number;
}[] = [
  { key: "gbPerMonth", label: "Bandwidth", unit: "GB", hint: "Egress bandwidth per month", minLog: 0, maxLog: 5 },
  { key: "messagesPerMonth", label: "Messages", unit: "msgs", hint: "Messages pushed per month", minLog: 3, maxLog: 10 },
  { key: "connectionSeconds", label: "Conn-seconds", unit: "sec", hint: "Total connection-seconds per month", minLog: 2, maxLog: 7 },
  { key: "concurrentSubscriptions", label: "Concurrent", unit: "subs", hint: "Concurrent subscriptions", minLog: 0, maxLog: 4 },
];

const VOLUME_CHIPS = [1_000_000, 10_000_000, 100_000_000, 1_000_000_000];
const BYTES_CHIPS = [0, 4_000, 64_000, 1_000_000];
const ADD_METHOD_DEFAULT = 1_000_000;

// Customize-pill styling, mirrored from the Overview control bar (OverviewBoard.tsx)
// so the disclosure reads identically across pages.
const PILL_BASE =
  "inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-full border text-[11px] sm:text-[12px] font-medium transition-colors hover:no-underline cursor-pointer";
const PILL_ACTIVE = "bg-accent border-accent text-accentfg";
const PILL_IDLE = "border-line2 text-fg2 hover:text-fg hover:border-fg2";
const CONTROL_PILL_W = "w-[100px] sm:w-[116px] shrink-0";

// Date the encoded pricing data was last refreshed (matches *.data.ts verified_on).
const LAST_UPDATED = new Date(2026, 5, 13).toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

// Log-scale volume slider: 100K → 10B, snapping to clean 1/2/5×10ⁿ values.
const VOL_MIN_LOG = 5;
const VOL_MAX_LOG = 10;
const SLIDER_MAX = 1000;
function niceRound(v: number): number {
  if (v <= 0) return 0;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const base = v / e;
  const r = base < 1.5 ? 1 : base < 3.5 ? 2 : base < 7.5 ? 5 : 10;
  return r * e;
}
function volToSlider(v: number): number {
  if (v <= 0) return 0;
  const l = Math.log10(v);
  return Math.max(0, Math.min(SLIDER_MAX, ((l - VOL_MIN_LOG) / (VOL_MAX_LOG - VOL_MIN_LOG)) * SLIDER_MAX));
}
function sliderToVol(s: number): number {
  const l = VOL_MIN_LOG + (s / SLIDER_MAX) * (VOL_MAX_LOG - VOL_MIN_LOG);
  return niceRound(Math.pow(10, l));
}
// Generic log-scale slider mapping (per-field min/max decades). Slider 0 = 0/off.
function logToSlider(v: number, minLog: number, maxLog: number): number {
  if (v <= 0) return 0;
  const l = Math.log10(v);
  return Math.max(0, Math.min(SLIDER_MAX, ((l - minLog) / (maxLog - minLog)) * SLIDER_MAX));
}
function sliderToLog(s: number, minLog: number, maxLog: number): number {
  if (s <= 0) return 0;
  const l = minLog + (s / SLIDER_MAX) * (maxLog - minLog);
  return niceRound(Math.pow(10, l));
}

// ── formatting ────────────────────────────────────────────────────────────
function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toPrecision(2)}`;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
function fmtUnits(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function fmtCompact(n: number): string {
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}
function fmtPerUnit(n: number | null): string {
  if (n == null) return "—";
  return `${fmtUsd(n * 1_000_000)}/1M`;
}
function fmtBytes(n: number): string {
  if (n <= 0) return "0";
  if (n < 1_000) return `${Math.round(n)} B`;
  if (n < 1_000_000) return `${(n / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })} KB`;
  return `${(n / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;
}
function fmtGb(n: number): string {
  if (n <= 0) return "0 GB";
  if (n < 0.1) return `${(n * 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })} MB`;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 0 })} GB`;
}
// Avg-response-size slider: 100 B → 100 MB (decades 2–8).
const BYTES_MIN_LOG = 2;
const BYTES_MAX_LOG = 8;
const sum = (m: Partial<Record<Method, number>>): number =>
  Object.values(m).reduce((a, c) => a + (c ?? 0), 0);

export default function CostsExplorer({ initialBasket }: { initialBasket: Basket }) {
  const pathname = usePathname();

  const empty =
    Object.keys(initialBasket.methods).length === 0 && initialBasket.streaming.length === 0;
  // Land on a populated Balanced basket so the comparison is meaningful immediately.
  const [methods, setMethods] = useState<Partial<Record<Method, number>>>(() =>
    empty ? basketFromProfile("balanced", DEFAULT_MONTHLY_CALLS).methods : initialBasket.methods,
  );
  const [streaming, setStreaming] = useState<Record<string, StreamingUsage>>(() => {
    const map: Record<string, StreamingUsage> = {};
    for (const u of initialBasket.streaming) map[u.kind] = u;
    return map;
  });
  const [planOverrides, setPlanOverrides] = useState<Record<string, string>>(
    initialBasket.planOverrides ?? {},
  );
  const [activePreset, setActivePreset] = useState<string | null>(empty ? "balanced" : null);
  const [volume, setVolume] = useState<number>(() =>
    empty ? DEFAULT_MONTHLY_CALLS : sum(initialBasket.methods) || DEFAULT_MONTHLY_CALLS,
  );
  const [peak, setPeak] = useState<number>(initialBasket.peakMultiplier ?? DEFAULT_PEAK_MULTIPLIER);
  // Avg RPC response size (bytes/call) — the user's own "GB on the wire" assumption.
  const [bytes, setBytes] = useState<number>(initialBasket.rpcBytesPerCall ?? 0);
  const [view, setView] = useState<View>(
    !empty && initialBasket.streaming.length > 0 && Object.keys(initialBasket.methods).length === 0
      ? "streaming"
      : "both",
  );
  const [basis, setBasis] = useState<Basis>("plan");
  const [display, setDisplay] = useState<DisplayMode>("usd");
  const [customizeOpen, setCustomizeOpen] = useState(false);
  // Once the open animation finishes, drop overflow:hidden so the toggle
  // tooltips can escape the reveal container instead of being clipped behind it.
  const [customizeExpanded, setCustomizeExpanded] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const shareRef = useRef<HTMLDivElement>(null);
  const [addMethod, setAddMethod] = useState<string>("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Basket the engine sees (zero the hidden half so RPC/Streaming-only is clean).
  const basket = useMemo<Basket>(() => {
    const streamArr = Object.values(streaming).filter(
      (u) =>
        (u.gbPerMonth ?? 0) > 0 ||
        (u.messagesPerMonth ?? 0) > 0 ||
        (u.connectionSeconds ?? 0) > 0 ||
        (u.concurrentSubscriptions ?? 0) > 0,
    );
    const b: Basket = {
      methods: view === "streaming" ? {} : methods,
      streaming: view === "rpc" ? [] : streamArr,
      peakMultiplier: peak,
    };
    if (Object.keys(planOverrides).length > 0) b.planOverrides = planOverrides;
    if (bytes > 0 && view !== "streaming") b.rpcBytesPerCall = bytes;
    return b;
  }, [methods, streaming, planOverrides, view, peak, bytes]);

  const { results } = useMemo(() => simulate(basket), [basket]);

  const costOf = useCallback(
    (r: ProviderCostResult): number | null => {
      if (basis === "plan") return r.totalUsd;
      if (r.marginalUsdPerUnit == null) return null;
      return r.marginalUsdPerUnit * r.totalUnits + r.streamingUsd;
    },
    [basis],
  );

  const ranked = useMemo(() => {
    const withCost = results.map((r) => ({ r, cost: costOf(r) }));
    withCost.sort((a, b) => {
      if (a.cost == null) return 1;
      if (b.cost == null) return -1;
      return a.cost - b.cost;
    });
    return withCost;
  }, [results, costOf]);
  const cheapest = ranked.find((x) => x.cost != null)?.r.providerId ?? null;

  const totalCalls = view === "streaming" ? 0 : sum(methods);
  const avgRps = totalCalls / SECONDS_PER_MONTH;
  const peakRps = avgRps * peak;
  // "GB on the wire": RPC egress (from the user's response-size assumption) +
  // streaming bandwidth the user dialed in. Provider-independent (it's traffic).
  const rpcGb = bytes > 0 && view !== "streaming" ? (totalCalls * bytes) / 1e9 : 0;
  const streamGb =
    view === "rpc"
      ? 0
      : Object.values(streaming).reduce((a, u) => a + (u.gbPerMonth ?? 0), 0);
  const wireGb = rpcGb + streamGb;

  // ── mutators ──────────────────────────────────────────────────────────────
  const applyPreset = (id: string) => {
    // Picking a preset resets monthly volume to the default (10M) and seeds the
    // basket at that volume — a fresh starting point, not the last slider value.
    const seeded = basketFromProfile(id, DEFAULT_MONTHLY_CALLS);
    setActivePreset(id);
    setVolume(DEFAULT_MONTHLY_CALLS);
    setMethods(seeded.methods);
    const map: Record<string, StreamingUsage> = {};
    for (const u of seeded.streaming) map[u.kind] = u;
    setStreaming(map);
    if (view === "streaming" && Object.keys(seeded.methods).length > 0) setView("both");
  };
  // Volume drives the whole basket: re-seed the active preset, or rescale a
  // custom basket proportionally so the slider always does something live.
  const changeVolume = (v: number) => {
    const vol = Math.max(0, Math.floor(v));
    setVolume(vol);
    if (activePreset) {
      setMethods(basketFromProfile(activePreset, vol).methods);
      return;
    }
    const total = sum(methods);
    if (total <= 0) return;
    const f = vol / total;
    const next: Partial<Record<Method, number>> = {};
    for (const [m, c] of Object.entries(methods)) {
      const nc = Math.round((c ?? 0) * f);
      if (nc > 0) next[m as Method] = nc;
    }
    setMethods(next);
  };
  // A manual method edit switches to "custom" and syncs the volume readout.
  const setMethodCount = (m: Method, raw: number | string) => {
    const n = Math.max(0, Math.floor(Number(raw) || 0));
    const next = { ...methods };
    if (n <= 0) delete next[m];
    else next[m] = n;
    setMethods(next);
    setActivePreset(null);
    setVolume(sum(next));
  };
  const setStreamValue = (kind: StreamKind, key: keyof StreamingUsage, n: number) => {
    const v = Math.max(0, Math.floor(n));
    setStreaming((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? { kind }), [key]: v } }));
  };
  // Fixed canonical order (ALL_METHODS) so rows NEVER reorder while a slider is
  // being dragged — sorting by count would make the row jump out from under the
  // cursor mid-drag.
  const activeMethods = ALL_METHODS.filter((m) => (methods[m] ?? 0) > 0);
  const addableMethods = [...ALL_METHODS].filter((m) => !activeMethods.includes(m)).sort();

  const exportCsv = () => {
    const headers = ["provider", "plan", "native_units", "unit", "rpc_usd", "streaming_usd", "total_usd", "marginal_usd_per_unit", "rpc_bandwidth_gb", "over_rate", "over_cap", "confidence", "caveats"];
    const rows = results.map((r) => [
      r.name,
      r.plan?.name ?? "—",
      Math.round(r.totalUnits),
      r.unitName,
      r.rpcUsd.toFixed(4),
      r.streamingUsd.toFixed(4),
      r.totalUsd.toFixed(4),
      r.marginalUsdPerUnit ?? "",
      r.rpcBandwidthGb.toFixed(4),
      String(r.limits.overRate),
      String(r.limits.overMonthlyCap),
      r.confidence,
      r.caveats.join(" | "),
    ]);
    triggerDownload("rpc-cost-comparison.csv", toCSV(headers, rows), "text/csv");
  };

  const exportJson = () => {
    const data = {
      basket: {
        methods,
        streaming: Object.values(streaming),
        peakMultiplier: peak,
        ...(bytes > 0 ? { rpcBytesPerCall: bytes } : {}),
      },
      results: results.map((r) => ({
        provider: r.providerId,
        name: r.name,
        plan: r.plan?.name ?? null,
        unit: r.unitName,
        nativeUnits: Math.round(r.totalUnits),
        rpcUsd: Number(r.rpcUsd.toFixed(4)),
        streamingUsd: Number(r.streamingUsd.toFixed(4)),
        totalUsd: Number(r.totalUsd.toFixed(4)),
        marginalUsdPerUnit: r.marginalUsdPerUnit,
        rpcBandwidthGb: Number(r.rpcBandwidthGb.toFixed(4)),
        overRate: r.limits.overRate,
        overCap: r.limits.overMonthlyCap,
        confidence: r.confidence,
        caveats: r.caveats,
      })),
    };
    triggerDownload("rpc-cost-comparison.json", JSON.stringify(data, null, 2), "application/json");
  };

  // Build a shareable link on demand (keeps the address bar clean during editing).
  const copyLink = async () => {
    const qs = encodeBasket(basket);
    const url = `${window.location.origin}${pathname}${qs ? `?${qs}` : ""}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. insecure context) — drop the link into the URL
      // bar instead so it can be copied manually.
      window.history.replaceState(window.history.state, "", url);
    }
  };

  // Keep the reveal clipped during the 300ms height transition, then allow
  // overflow so hover tooltips on the toggles aren't cut off. Clip again the
  // instant it closes so the collapse animation stays clean.
  useEffect(() => {
    if (!customizeOpen) {
      setCustomizeExpanded(false);
      return;
    }
    const id = window.setTimeout(() => setCustomizeExpanded(true), 320);
    return () => window.clearTimeout(id);
  }, [customizeOpen]);

  // Close the Share dropdown on outside-click or Escape.
  useEffect(() => {
    if (!shareOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (shareRef.current && !shareRef.current.contains(e.target as Node)) setShareOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setShareOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [shareOpen]);

  // ── render ──────────────────────────────────────────────────────────────
  return (
    <div className="cost-page">
      <header className="max-w-[820px] pt-1">
        <span className="section-kicker">Costs</span>
        <h1 className="text-[clamp(26px,4vw,38px)] font-semibold tracking-[-0.025em] leading-[1.08] mt-2 mb-0 text-fg">
          RPC cost comparator
        </h1>
        <p className="mt-3 font-geistmono text-[11px] uppercase tracking-[0.12em] text-muted">
          Last updated: {LAST_UPDATED}
        </p>
        <p className="mt-4 mb-4 text-[14.5px] leading-[1.6] text-fg2 max-w-[64ch]">
          Pick a workload and monthly volume to compare what each provider would charge, in USD and
          native units. <em>Simulated</em> from published pricing, accounting for plan tiers, credit
          caps, and rate limits. No calls are made.
        </p>
        <a
          href="/costs/reference"
          className="group mb-6 inline-flex items-center gap-1.5 rounded-full border border-accent/40 px-3.5 py-[7px] text-[13px] font-medium text-accent transition-colors hover:bg-accent/10 hover:border-accent hover:no-underline"
        >
          Pricing reference
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            aria-hidden="true"
            className="transition-transform group-hover:translate-x-0.5"
          >
            <path
              d="M5 12h14M13 5l7 7-7 7"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </header>

      {/* ── Controls — Overview-style pill bar: wide presets + Customize ───── */}
      <section className="cost-controls">
        <div className="cost-workrow">
          <span className="cost-ctl-label cost-work-label">Workload</span>
          <div className="cost-pillrow">
            {PRESET_OPTIONS.map((p) => {
              const active = activePreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  title={p.description}
                  aria-pressed={active}
                  onClick={() => applyPreset(p.id)}
                  className={"flex-1 min-w-0 " + PILL_BASE + " " + (active ? PILL_ACTIVE : PILL_IDLE)}
                >
                  <span className="truncate">{p.label}</span>
                </button>
              );
            })}
            {/* Customize — to the right of the preset pills, like Overview. */}
            <button
              type="button"
              onClick={() => setCustomizeOpen((o) => !o)}
              aria-expanded={customizeOpen}
              className={CONTROL_PILL_W + " " + PILL_BASE + " " + (customizeOpen ? PILL_ACTIVE : PILL_IDLE)}
            >
              <span className="truncate">Customize</span>
              <svg
                viewBox="0 0 24 24"
                width="11"
                height="11"
                aria-hidden="true"
                className={"shrink-0 " + (customizeOpen ? "rotate-180 transition-transform" : "transition-transform")}
              >
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {/* Share — same row as the pills, trigger matches the Overview Share button. */}
            <div className="cost-share" ref={shareRef}>
              <button
                type="button"
                onClick={() => setShareOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={shareOpen}
                className={"shrink-0 " + PILL_BASE + " " + (shareOpen ? PILL_ACTIVE : PILL_IDLE)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="truncate">Share</span>
              </button>
              {shareOpen && (
                <div className="cost-share-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      void copyLink();
                    }}
                    className="cost-share-item"
                  >
                    {copied ? "Copied ✓" : "Copy link"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      exportCsv();
                      setShareOpen(false);
                    }}
                    className="cost-share-item"
                  >
                    CSV
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      exportJson();
                      setShareOpen(false);
                    }}
                    className="cost-share-item"
                  >
                    JSON
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Customize reveal — directly under the pills (same grid-rows reveal as Overview). */}
        <div
          className={
            "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none " +
            (customizeOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
          }
        >
          <div
            className={
              (customizeExpanded ? "overflow-visible " : "overflow-hidden ") +
              "transition-opacity duration-300 ease-out " +
              (customizeOpen ? "opacity-100" : "opacity-0")
            }
          >
            <div className="cost-customize-body">
              {/* Two matched slider tuners — same size & style */}
              <div className="cost-tuner">
                <div className="cost-tuner-head">
                  <span className="cost-ctl-label">Monthly volume</span>
                  <span className="cost-tuner-val">
                    {fmtCompact(volume)}
                    <i>calls/mo</i>
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={SLIDER_MAX}
                  value={volToSlider(volume)}
                  onChange={(e) => changeVolume(sliderToVol(Number(e.target.value)))}
                  className="vol-slider"
                  aria-label="Monthly call volume"
                />
                <div className="chip-row">
                  {VOLUME_CHIPS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => changeVolume(v)}
                      className={`chip chip-sm${volume === v ? " chip-on" : ""}`}
                    >
                      {fmtCompact(v)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="cost-tuner">
                <div className="cost-tuner-head">
                  <span
                    className="cost-ctl-label cost-ctl-label-tip"
                    title="Your assumption for avg RPC response size. Drives 'GB on the wire' and the egress surcharge on providers that bill bandwidth (Triton). Off = bandwidth excluded."
                  >
                    Avg response size
                  </span>
                  <span className="cost-tuner-val">
                    {bytes > 0 ? fmtBytes(bytes) : "Off"}
                    {bytes > 0 && <i>/call</i>}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={SLIDER_MAX}
                  value={logToSlider(bytes, BYTES_MIN_LOG, BYTES_MAX_LOG)}
                  onChange={(e) =>
                    setBytes(
                      Math.min(
                        MAX_BYTES_PER_CALL,
                        sliderToLog(Number(e.target.value), BYTES_MIN_LOG, BYTES_MAX_LOG),
                      ),
                    )
                  }
                  className="vol-slider"
                  aria-label="Average response size"
                />
                <div className="chip-row">
                  {BYTES_CHIPS.map((b) => (
                    <button
                      key={b}
                      type="button"
                      onClick={() => setBytes(b)}
                      className={`chip chip-sm${bytes === b ? " chip-on" : ""}`}
                    >
                      {b === 0 ? "Off" : fmtBytes(b)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Display + scoring toggles, divided from the sliders */}
              <div className="cost-tuner-row">
                <Segmented
                  label="Show"
                  hint="Compare RPC calls only, streaming only, or both combined."
                  value={view}
                  onChange={(v) => setView(v as View)}
                  options={[
                    { value: "both", label: "RPC + Stream" },
                    { value: "rpc", label: "RPC" },
                    { value: "streaming", label: "Streaming" },
                  ]}
                />
                <Segmented
                  label="Basis"
                  hint="How each provider's price is computed. Plan-aware: total bill on the cheapest plan that fits your volume and rate limits. Marginal: just the per-unit overage rate × your usage — no plan fees or included units, for a like-for-like per-call rate."
                  value={basis}
                  onChange={(v) => setBasis(v as Basis)}
                  options={[
                    { value: "plan", label: "Plan-aware" },
                    { value: "marginal", label: "Marginal" },
                  ]}
                />
                <Segmented
                  label="Headline"
                  hint="Show the Total column as USD, or as the provider's own native units (Helius credits · Alchemy compute units · QuickNode API credits · Triton requests)."
                  value={display}
                  onChange={(v) => setDisplay(v as DisplayMode)}
                  options={[
                    { value: "usd", label: "USD" },
                    { value: "units", label: "Units" },
                  ]}
                />
                <div className="cost-peak-inline">
                  <span
                    className="cost-ctl-label cost-ctl-label-tip"
                    title="Peak-to-average burst factor used for the rate-limit check."
                  >
                    Peak burst
                  </span>
                  <input
                    type="number"
                    min={1}
                    step={0.5}
                    value={peak}
                    onChange={(e) => setPeak(Math.max(1, Number(e.target.value) || 1))}
                    className="num-input w-[60px]"
                  />
                  <span className="text-muted text-[12px]">× avg</span>
                </div>
              </div>
            </div>
          </div>
        </div>

      </section>

      {/* ── Results (the hero) ───────────────────────────────────────────── */}
      <section className="cost-results">
        <div className="cost-results-head">
          <span className="section-kicker">Estimated monthly cost</span>
          <span className="cost-implied-group">
            {wireGb > 0 && (
              <span
                className="cost-implied"
                title={
                  rpcGb > 0 && streamGb > 0
                    ? `${fmtGb(rpcGb)} RPC egress + ${fmtGb(streamGb)} streaming`
                    : rpcGb > 0
                      ? `RPC egress at ${fmtBytes(bytes)}/call × ${fmtCompact(totalCalls)} calls`
                      : "Streaming bandwidth"
                }
              >
                ~{fmtGb(wireGb)} on the wire
              </span>
            )}
            {totalCalls > 0 && (
              <span className="cost-implied" title={`Average ${fmtUnits(avgRps)} RPS × ${peak} peak factor`}>
                ~{fmtUnits(peakRps)} RPS peak
              </span>
            )}
          </span>
        </div>

        <div className="prov-table-wrap cost-table-wrap">
          <table className="prov-table cost-table">
            <thead>
              <tr>
                <th className="prov-num">#</th>
                <th>Provider</th>
                <th>Plan</th>
                <th className="prov-num">{display === "usd" ? "Total /mo" : "Native units"}</th>
                <th className="prov-num">
                  <FloatingTooltip
                    title="$/1M units"
                    trigger={<span style={{ cursor: "help", borderBottom: "1px dotted currentColor" }}>$/1M units</span>}
                  >
                    <div className="text-[12px] leading-[1.5]">
                      <div className="font-semibold text-neutral-100 mb-1">$/1M units</div>
                      <div>
                        Marginal USD per 1 million billing units (requests, credits, or
                        compute units — varies by provider).
                      </div>
                    </div>
                  </FloatingTooltip>
                </th>
                <th>Flags</th>
                <th aria-label="expand" />
              </tr>
            </thead>
            <tbody>
              {ranked.map(({ r, cost }, i) => {
                const isLeader = r.providerId === cheapest && cost != null && i === 0;
                const brand = brandColorFor(r.providerId);
                const logo = logoFor(r.providerId);
                const isOpen = expanded === r.providerId;
                const providerPlans = plansForProvider(r.providerId);
                const totalCell =
                  display === "usd"
                    ? cost == null
                      ? "—"
                      : fmtUsd(cost)
                    : r.totalUnits > 0
                      ? `${fmtCompact(r.totalUnits)} ${r.unitName}`
                      : "—";
                return (
                  <Fragment key={r.providerId}>
                    <tr
                      role="button"
                      tabIndex={0}
                      className={`cost-trow${isLeader ? " is-leader" : ""}${isOpen ? " is-open" : ""}`}
                      onClick={() => setExpanded(isOpen ? null : r.providerId)}
                      onKeyDown={(e: KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setExpanded(isOpen ? null : r.providerId);
                        }
                      }}
                      aria-expanded={isOpen}
                    >
                      <td className="prov-num cost-rank-c">{i + 1}</td>
                      <td>
                        <span className="cost-prov-cell">
                          {logo && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={logo} alt="" width={18} height={18} className="cost-logo" />
                          )}
                          <span className="cost-prov-name" style={brand ? { color: brand } : undefined}>
                            {r.name}
                          </span>
                        </span>
                      </td>
                      <td className="cost-plan-cell">
                        {r.plan ? r.plan.name : "no public plan"}
                        {r.plan && !planOverrides[r.providerId] && (
                          <span className="cost-auto"> · auto</span>
                        )}
                      </td>
                      <td className="prov-num cost-total">{totalCell}</td>
                      <td className="prov-num">{fmtPerUnit(r.marginalUsdPerUnit)}</td>
                      <td>
                        <span className="cost-table-flags">
                          <CapacityBadge result={r} />
                          <ConfidenceTag confidence={r.confidence} />
                          <CaveatBadge result={r} />
                          <PlanFeatureTags result={r} />
                        </span>
                      </td>
                      <td className="prov-num">
                        <span className={`cost-caret${isOpen ? " is-open" : ""}`} aria-hidden="true">
                          ›
                        </span>
                      </td>
                    </tr>

                    {/* Detail row always mounted; the grid-rows reveal animates
                        it open/closed like the rest of the app. */}
                    <tr className="cost-detail-row">
                      <td colSpan={7}>
                        <div
                          className={
                            "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none " +
                            (isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
                          }
                        >
                          <div
                            className={
                              "overflow-hidden transition-opacity duration-300 ease-out " +
                              (isOpen ? "opacity-100" : "opacity-0")
                            }
                          >
                            <div className="cost-detail">
                            <div className="cost-detail-bar">
                              {providerPlans.length > 0 && (
                                <label className="cost-detail-plan">
                                  <span className="cost-ctl-label">Plan</span>
                                  <select
                                    // Bind to the OVERRIDE only (not the resolved plan), so "auto"
                                    // stays selectable — otherwise picking it would snap straight
                                    // back to the auto-picked plan id. The resolved plan shows in
                                    // the row ("Business · auto").
                                    value={planOverrides[r.providerId] ?? ""}
                                    onChange={(e) =>
                                      setPlanOverrides((prev) => {
                                        const nextO = { ...prev };
                                        if (e.target.value) nextO[r.providerId] = e.target.value;
                                        else delete nextO[r.providerId];
                                        return nextO;
                                      })
                                    }
                                    className="num-input"
                                  >
                                    <option value="">
                                      auto{r.plan ? ` — ${r.plan.name}` : " (cheapest that fits)"}
                                    </option>
                                    {providerPlans.map((pl) => (
                                      <option key={pl.id} value={pl.id}>
                                        {pl.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              )}
                            </div>

                            {r.notes.length > 0 && (
                              <ul className="cost-notes">
                                {r.notes.map((n, k) => (
                                  <li key={k}>{n}</li>
                                ))}
                              </ul>
                            )}

                            {r.breakdown.length > 0 && (
                              <table className="prov-table cost-breakdown">
                                <thead>
                                  <tr>
                                    <th>Method</th>
                                    <th className="prov-num">Calls</th>
                                    <th className="prov-num">{r.unitName}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.breakdown.map((b) => (
                                    <tr key={b.method}>
                                      <td>
                                        <code className="text-[12px]">{b.method}</code>
                                      </td>
                                      <td className="prov-num">{fmtCompact(b.calls)}</td>
                                      <td className="prov-num">
                                        {b.note === "unsupported" ? (
                                          <span className="badge warn">unsupported</span>
                                        ) : b.note === "unknown_cost" ? (
                                          <span className="badge warn">cost unknown</span>
                                        ) : (
                                          fmtCompact(b.units)
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}

                            {r.streamingBreakdown.length > 0 && (
                              <ul className="cost-stream-lines">
                                {r.streamingBreakdown.map((s, k) => (
                                  <li key={`${s.kind}-${k}`}>
                                    <span>{s.kind}</span>
                                    <span>
                                      {s.note === "unavailable" ? (
                                        <span className="badge bad">not offered</span>
                                      ) : s.note === "plan_gated" ? (
                                        <span className="badge warn">needs higher plan</span>
                                      ) : s.note === "unknown_cost" ? (
                                        <span className="badge warn">not metered</span>
                                      ) : (
                                        fmtUsd(s.usd)
                                      )}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Fine-tune editors (collapsible, animated) ────────────────────── */}
      <section className="cost-editors">
        {view !== "streaming" && (
          <Collapsible
            title="Fine-tune calls"
            defaultOpen={activePreset === null && activeMethods.length > 0}
            meta={
              <>
                {activeMethods.length} method{activeMethods.length === 1 ? "" : "s"} ·{" "}
                {fmtCompact(totalCalls)}/mo
              </>
            }
          >
              <div className="chip-row">
                <select
                  value={addMethod}
                  onChange={(e) => {
                    const m = e.target.value as Method;
                    if (m) {
                      setMethodCount(m, ADD_METHOD_DEFAULT);
                      setAddMethod("");
                    }
                  }}
                  className="num-input cost-add"
                >
                  <option value="">+ add method…</option>
                  {addableMethods.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="slider-list">
                {activeMethods.length === 0 && (
                  <p className="text-muted text-[12px] italic">
                    No methods — pick a workload above or add one.
                  </p>
                )}
                {activeMethods.map((m) => (
                  <div key={m} className="srow">
                    <code className="srow-label" title={m}>
                      {m}
                    </code>
                    <LogSlider
                      value={methods[m] ?? 0}
                      onChange={(v) => setMethodCount(m, v)}
                      minLog={3}
                      maxLog={10}
                      unit="calls"
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${m}`}
                      onClick={() => setMethodCount(m, 0)}
                      className="mchip-x"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
          </Collapsible>
        )}

        {view !== "rpc" && (
          <Collapsible title="Streaming usage" meta="bandwidth · messages · connections" bodyClassName="stream-grid">
            {STREAM_KINDS.map(({ kind, label }) => {
              const u = streaming[kind];
              return (
                <div key={kind} className="stream-card">
                  <div className="stream-card-title">{label}</div>
                  <div className="saxis-list">
                    {STREAM_AXES.map((axis) => (
                      <div key={axis.key} className="saxis" title={axis.hint}>
                        <span className="saxis-label">{axis.label}</span>
                        <LogSlider
                          value={(u?.[axis.key] as number | undefined) ?? 0}
                          onChange={(v) => setStreamValue(kind, axis.key, v)}
                          minLog={axis.minLog}
                          maxLog={axis.maxLog}
                          unit={axis.unit}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </Collapsible>
        )}

        {view !== "rpc" && (
          <Collapsible title="Streaming availability" meta="who offers what · min plan">
            <StreamingRestrictions results={results} />
            <p className="cost-foot">
              Pre-execution / shred latency figures are vendor-stated, not independently
              benchmarked head-to-head.
            </p>
          </Collapsible>
        )}
      </section>

      <p className="cost-foot">
        USD is the only cross-provider axis — native units differ (Helius credits · Alchemy CUs ·
        QuickNode API credits · Triton per-request). No calls are made.
      </p>
      <ul className="cost-foot-list">
        <li>
          <b>Plan-aware</b> = total bill on the cheapest plan that fits your volume and rate limits;{" "}
          <b>Marginal</b> = just the per-unit overage rate × your usage (no plan fees or included
          units), for a like-for-like per-call rate.
        </li>
        <li>
          <b>Avg response size</b> is your own assumption (we don&apos;t measure payloads) — it sets
          the &ldquo;GB on the wire&rdquo; figure and the bandwidth charge for providers that bill
          egress (Triton $0.08/GB). Leave at 0 to skip bandwidth.
        </li>
        <li>
          <b>est.</b> — some figures are unknown or unsupported. <b>lower bound</b> — the real bill
          is higher (unmodeled QuickNode 2×/4× multipliers or egress).
        </li>
      </ul>

      <style>{`
        .cost-page { padding-bottom: 40px; }

        /* Controls — Overview-style pill bar */
        .cost-controls {
          display: flex;
          flex-direction: column;
          padding: 12px 0;
          border-top: 1px solid var(--border);
          border-bottom: 1px solid var(--border);
        }
        .cost-workrow { display: flex; align-items: center; gap: 12px; }
        .cost-work-label { flex: none; }
        @media (max-width: 559px) { .cost-work-label { display: none; } }
        .cost-pillrow { display: flex; align-items: stretch; gap: 6px; flex: 1; min-width: 0; }
        /* Share dropdown — sits in the pill row; trigger styled via PILL_BASE */
        .cost-share { position: relative; flex: none; }
        .cost-share-menu {
          position: absolute; top: calc(100% + 6px); right: 0; z-index: 20;
          display: flex; flex-direction: column; min-width: 160px; padding: 5px;
          background: var(--bg); border: 1px solid var(--border-2); border-radius: 10px;
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
        }
        .cost-share-item {
          text-align: left; background: none; border: none; cursor: pointer;
          padding: 8px 10px; border-radius: 6px; font-size: 12.5px; color: var(--text-2);
          transition: background .12s, color .12s;
        }
        .cost-share-item:hover { background: var(--surface-2); color: var(--text); }
        .cost-ctl-label {
          font-family: var(--font-mono); font-size: 10px; letter-spacing: .14em;
          text-transform: uppercase; color: var(--muted);
        }
        .cost-ctl-label-tip { cursor: help; text-decoration: underline dotted; text-underline-offset: 3px; text-decoration-color: var(--border-2); }
        .cost-ctl-label-tip:hover { color: var(--text-2); }
        .vol-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 3px; border-radius: 3px; background: var(--border-2); cursor: pointer; }
        .vol-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%; background: var(--accent); cursor: pointer; border: 2px solid var(--bg); }
        .vol-slider::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: var(--accent); cursor: pointer; border: 2px solid var(--bg); }

        /* Chips (presets, volume quick-picks, ghost buttons) */
        .chip-row { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
        .chip {
          display: inline-flex; align-items: center; border: 1px solid var(--border-2);
          background: var(--surface); color: var(--text-2); border-radius: 999px;
          padding: 5px 13px; font-size: 12.5px; cursor: pointer;
          transition: color .14s, border-color .14s, background .14s;
        }
        .chip:hover { color: var(--text); border-color: var(--text-2); }
        .chip-on { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); font-weight: 500; }
        .chip-sm { padding: 4px 11px; font-size: 11.5px; font-family: var(--font-mono); }
        .chip-ghost { background: transparent; color: var(--muted); }

        /* Customize reveal content — full-width grid; the two sliders sit
           side-by-side on desktop, stacking only on narrow screens. */
        .cost-customize-body {
          display: grid; grid-template-columns: 1fr; gap: 22px 36px;
          padding: 18px 0 8px;
        }
        @media (min-width: 720px) { .cost-customize-body { grid-template-columns: 1fr 1fr; } }
        /* Matched slider tuners (Monthly volume + Avg response size) — fill the column */
        .cost-tuner { display: flex; flex-direction: column; gap: 11px; min-width: 0; }
        .cost-tuner-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
        .cost-tuner-val { font-family: var(--font-mono); font-size: 14px; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
        .cost-tuner-val i { font-style: normal; color: var(--muted); font-size: 11px; margin-left: 5px; }
        /* Toggle/peak row spans the full width below the sliders */
        .cost-tuner-row { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 16px 26px; }
        .cost-peak-inline { display: flex; align-items: center; gap: 9px; }
        .seg-wrap { display: flex; align-items: center; gap: 9px; }
        .seg { display: inline-flex; padding: 2px; gap: 2px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
        .seg-opt {
          border: none; background: transparent; color: var(--text-2); cursor: pointer;
          padding: 4px 11px; border-radius: 6px; font-size: 12.5px; transition: color .14s, background .14s;
        }
        .seg-opt:hover { color: var(--text); }
        .seg-opt.is-on { background: var(--surface-2); color: var(--text); box-shadow: inset 0 0 0 1px var(--border-2); }

        /* Results */
        .cost-results { margin-top: 26px; }
        .cost-results-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
        .cost-implied-group { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; justify-content: flex-end; }
        .cost-implied { font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); white-space: nowrap; }
        .cost-caret { color: var(--muted); font-size: 18px; display: inline-block; transition: transform .18s ease; width: 12px; text-align: center; }
        .cost-caret.is-open { transform: rotate(90deg); }

        /* Detail panel (rendered inside the expanded table row) */
        /* Bounded so a long basket (e.g. Balanced = 45 methods) doesn't blow the
           row open the full page; the content scrolls within a fixed cap. */
        .cost-detail { padding: 6px 4px 18px 2px; display: flex; flex-direction: column; gap: 14px; max-height: 340px; overflow-y: auto; }
        .cost-detail-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
        .cost-detail-plan { display: inline-flex; align-items: center; gap: 8px; }
        .cost-notes { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
        .cost-notes li { font-size: 12.5px; line-height: 1.45; color: var(--text-2); padding-left: 14px; position: relative; }
        .cost-notes li::before { content: "•"; position: absolute; left: 2px; color: var(--muted); }
        .cost-breakdown { width: 100%; }
        .cost-stream-lines { list-style: none; margin: 0; padding: 0; width: 100%; display: flex; flex-direction: column; gap: 6px; }
        .cost-stream-lines li { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; color: var(--text-2); border-bottom: 1px solid var(--border); padding-bottom: 5px; }

        /* Fine-tune editors */
        .cost-editors { margin-top: 28px; display: flex; flex-direction: column; gap: 12px; }
        .cost-panel { border: 1px solid var(--border); border-radius: 10px; background: transparent; }
        .cost-panel-head { display: flex; align-items: center; gap: 10px; width: 100%; cursor: pointer; padding: 12px 16px; font-size: 13.5px; color: var(--text); background: none; border: none; text-align: left; font-family: inherit; }
        .cost-panel-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 10px; }
        .cost-panel-meta { margin-left: auto; font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
        .cost-panel-body { padding: 4px 16px 16px; display: flex; flex-direction: column; gap: 14px; }
        .cost-add { max-width: 240px; }
        .mchip-x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; }
        .mchip-x:hover { color: var(--text); }

        /* Slider rows (methods + streaming axes) */
        /* Fixed height + scroll so a big basket (Balanced = 45 methods) doesn't
           run the panel down the whole page. */
        .slider-list { display: flex; flex-direction: column; max-height: 340px; overflow-y: auto; padding-right: 14px; }
        .srow { display: grid; grid-template-columns: minmax(0, 180px) 1fr auto; align-items: center; gap: 14px; padding: 8px 0; border-bottom: 1px solid var(--border); }
        .srow:last-child { border-bottom: none; }
        .srow-label { font-family: var(--font-mono); font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .lslider { display: flex; align-items: center; gap: 12px; min-width: 0; }
        .lslider .vol-slider { flex: 1; min-width: 80px; }
        .lslider-val { font-family: var(--font-mono); font-size: 12px; color: var(--text); font-variant-numeric: tabular-nums; min-width: 92px; text-align: right; white-space: nowrap; }
        .lslider-val i { font-style: normal; color: var(--muted); font-size: 10.5px; }

        .stream-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
        @media (min-width: 720px) { .stream-grid { grid-template-columns: 1fr 1fr; } }
        .stream-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; background: var(--bg); }
        .stream-card-title { font-size: 12.5px; color: var(--text); margin-bottom: 8px; font-weight: 500; }
        .saxis-list { display: flex; flex-direction: column; }
        .saxis { display: grid; grid-template-columns: 92px 1fr; align-items: center; gap: 12px; padding: 6px 0; }
        .saxis-label { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
        .saxis .lslider-val { min-width: 78px; }
        @media (max-width: 520px) {
          .srow { grid-template-columns: minmax(0, 110px) 1fr auto; gap: 10px; }
        }

        /* Shared inputs */
        .num-input { background: var(--bg); border: 1px solid var(--border-2); border-radius: 6px; padding: 6px 9px; color: var(--text); font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
        .num-input:focus { outline: none; border-color: var(--accent); }
        select.num-input { cursor: pointer; }

        .cost-foot { margin-top: 24px; font-size: 11.5px; line-height: 1.6; color: var(--muted); }
        .cost-foot b { color: var(--text-2); font-weight: 600; }
        .cost-foot-list { margin: 8px 0 0; padding-left: 16px; display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; line-height: 1.55; color: var(--muted); }
        .cost-foot-list li { list-style: disc; }
        .cost-foot-list b { color: var(--text-2); font-weight: 600; }

        /* Comparison table — matches the cold-p95 latency table: mono, cells in
           --text, no leader highlight, animated row expand. */
        /* Keep the table bounded to the container and scroll horizontally when it
           doesn't fit, rather than letting a wide table push out the whole page.
           Inherits overflow-x:auto from .prov-table-wrap; flag hover-tooltips open
           over the rows below them inside the scroll box (and use the BottomSheet
           on touch). */
        .cost-table-wrap { margin-top: 8px; max-width: 100%; }
        .cost-table { width: 100%; }
        .cost-table td { color: var(--text); vertical-align: middle; }
        .cost-trow { cursor: pointer; }
        .cost-trow:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
        .cost-rank-c { color: var(--muted); }
        .cost-prov-cell { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
        .cost-table .cost-prov-name { font-size: 13px; font-weight: 600; letter-spacing: 0; color: var(--text); }
        .cost-table .cost-logo { width: 18px; height: 18px; border-radius: 4px; flex: none; }
        .cost-plan-cell { white-space: nowrap; color: var(--text-2); }
        .cost-auto { color: var(--muted); }
        .cost-table-flags { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        /* Always-mounted detail row: no border/padding so collapsed rows add no
           gap; the inner grid-rows wrapper animates the reveal. */
        .cost-table tr.cost-detail-row, .cost-table tr.cost-detail-row:hover { background: transparent; }
        .cost-table tr.cost-detail-row > td { padding: 0; border-bottom: none; box-shadow: none; }

        /* Streaming availability matrix */
        .stream-restrict td:first-child, .stream-restrict th:first-child { white-space: nowrap; }

        .caveat-list { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 6px; }
        .caveat-list li { list-style: disc; }
      `}</style>
    </div>
  );
}

// ── presentational helpers ──────────────────────────────────────────────────
/** Log-scale slider with a compact value readout. Slider at 0 = off (value 0). */
function LogSlider({
  value,
  onChange,
  minLog,
  maxLog,
  unit,
  fmt,
}: {
  value: number;
  onChange: (v: number) => void;
  minLog: number;
  maxLog: number;
  unit?: string;
  /** Custom value formatter (e.g. bytes → "256 KB"). Defaults to fmtCompact + unit. */
  fmt?: (v: number) => string;
}) {
  return (
    <div className="lslider">
      <input
        type="range"
        min={0}
        max={SLIDER_MAX}
        value={logToSlider(value, minLog, maxLog)}
        onChange={(e) => onChange(sliderToLog(Number(e.target.value), minLog, maxLog))}
        className="vol-slider"
        aria-label={unit ? `value in ${unit}` : "value"}
      />
      <span className="lslider-val">
        {fmt ? fmt(value) : value > 0 ? fmtCompact(value) : "0"}
        {!fmt && unit && <i> {unit}</i>}
      </span>
    </div>
  );
}

/**
 * Animated disclosure panel — same grid-rows reveal as the Customize section and
 * the leaderboard row-expand. Clips during the transition, then switches to
 * overflow:visible once open so inner tooltips/scroll lists aren't cut off.
 */
function Collapsible({
  title,
  meta,
  defaultOpen = false,
  bodyClassName,
  children,
}: {
  title: string;
  meta?: ReactNode;
  defaultOpen?: boolean;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState(defaultOpen);
  useEffect(() => {
    if (!open) {
      setExpanded(false);
      return;
    }
    const id = window.setTimeout(() => setExpanded(true), 320);
    return () => window.clearTimeout(id);
  }, [open]);
  return (
    <div className="cost-panel">
      <button
        type="button"
        className="cost-panel-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={"cost-caret" + (open ? " is-open" : "")} aria-hidden="true">
          ›
        </span>
        {title}
        {meta != null && <span className="cost-panel-meta">{meta}</span>}
      </button>
      <div
        className={
          // min-w-0 lets the grid item shrink below its content's intrinsic width
          // so a wide inner table (.prov-table-wrap) clips + scrolls instead of
          // expanding the page on narrow viewports.
          "grid min-w-0 transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none " +
          (open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
        }
      >
        <div
          className={
            "min-w-0 " +
            (expanded ? "overflow-visible " : "overflow-hidden ") +
            "transition-opacity duration-300 ease-out " +
            (open ? "opacity-100" : "opacity-0")
          }
        >
          <div className={"cost-panel-body" + (bodyClassName ? " " + bodyClassName : "")}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function Segmented({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string;
  /** Optional explanation shown as a tooltip on the label (dotted underline). */
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="seg-wrap">
      {hint ? (
        <Tooltip
          align="left"
          title={label}
          trigger={<span className="cost-ctl-label cost-ctl-label-tip">{label}</span>}
        >
          <div className="text-[12px] leading-[1.5]">
            <div className="font-semibold text-neutral-100 mb-1">{label}</div>
            <div>{hint}</div>
          </div>
        </Tooltip>
      ) : (
        <span className="cost-ctl-label">{label}</span>
      )}
      <div className="seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`seg-opt${value === o.value ? " is-on" : ""}`}
            aria-pressed={value === o.value}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A badge with a hover/tap tooltip (title heading + explanatory body). */
function BadgeTip({
  cls,
  label,
  title,
  children,
}: {
  cls: string;
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    // FloatingTooltip portals the popup to <body> with fixed positioning, so it
    // escapes the table's overflow-x scroll container (which would otherwise clip
    // it) and auto-clamps within the viewport — no manual edge alignment needed.
    <FloatingTooltip
      title={title}
      trigger={<span className={`badge ${cls}`.trimEnd()}>{label}</span>}
    >
      <div className="text-[12px] leading-[1.5]">
        <div className="font-semibold text-neutral-100 mb-1">{title}</div>
        <div>{children}</div>
      </div>
    </FloatingTooltip>
  );
}

/**
 * Capacity/rate feasibility badge against the chosen plan, each with a tooltip
 * explaining what it means:
 *  - over cap  (red):     hard-cap plan whose monthly allotment the basket exceeds
 *  - over rate (amber):   implied peak rate exceeds the plan's RPS / CU-s limit
 *  - +overage  (neutral): exceeds included allotment but overage covers it
 *  - ok        (green):   within both limits
 */
function CapacityBadge({ result }: { result: ProviderCostResult }) {
  if (!result.plan) return null;
  const L = result.limits;
  const plan = result.plan.name;
  if (L.overMonthlyCap) {
    return (
      <BadgeTip cls="bad" label="over cap" title="Monthly cap exceeded">
        Your volume needs {fmtUnits(result.totalUnits)} {result.unitName}/mo, but the {plan} plan
        caps at {fmtUnits(result.includedUnits ?? 0)} with no overage — you&apos;d need a higher tier.
      </BadgeTip>
    );
  }
  if (L.overRate) {
    const detail =
      L.rateBasis === "cu_per_second"
        ? `~${fmtUnits(L.impliedCuPerSecond)} CU/s vs the ${fmtUnits(L.cuPerSecond ?? 0)} CU/s limit`
        : `~${fmtUnits(L.impliedRps)} RPS vs the ${fmtUnits(L.rps ?? 0)} RPS limit`;
    return (
      <BadgeTip cls="warn" label="over rate" title="Rate limit exceeded">
        Your implied peak ({detail}) is above the {plan} plan&apos;s limit — sustained bursts would
        be throttled. Lower the Peak × factor or move to a higher tier.
      </BadgeTip>
    );
  }
  if (L.exceedsIncluded) {
    return (
      <BadgeTip cls="" label="+overage" title="Billed as overage">
        Volume exceeds the {plan} plan&apos;s included allotment; the extra is billed at the overage
        rate. This is still the cheapest plan that fits.
      </BadgeTip>
    );
  }
  return (
    <BadgeTip cls="good" label="ok" title="Within plan limits">
      Your monthly volume and peak request rate both fit within the {plan} plan — no overage and no
      rate-limit throttling.
    </BadgeTip>
  );
}

/** Confidence tag (only shown when not exact), with an explanatory tooltip. */
function ConfidenceTag({ confidence }: { confidence: ProviderCostResult["confidence"] }) {
  if (confidence === "exact") return null;
  if (confidence === "unavailable") {
    return (
      <BadgeTip cls="bad" label="n/a" title="No public pricing">
        This provider doesn&apos;t publish pricing we can model, so it&apos;s excluded from the
        ranking.
      </BadgeTip>
    );
  }
  return (
    <BadgeTip cls="warn" label="est." title="Partial estimate">
      Some method costs are unknown or unsupported on this provider, so they&apos;re excluded from
      the total — treat it as a lower bound. Expand the row to see which.
    </BadgeTip>
  );
}

/**
 * "Lower bound" flag: the total is understated because a provider bills something
 * we deliberately don't model rather than guess — QuickNode's unpublished 2×/4×
 * heavy-call multipliers, or egress the user hasn't given a response size for.
 * Distinct from `est.` (which is about unknown/unsupported per-method costs).
 */
function CaveatBadge({ result }: { result: ProviderCostResult }) {
  if (result.caveats.length === 0) return null;
  return (
    <BadgeTip cls="warn" label="lower bound" title="Likely under-counted">
      <ul className="caveat-list">
        {result.caveats.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
    </BadgeTip>
  );
}

/** Scannable billing-shape chips: prepaid deposit and per-call premium. */
function PlanFeatureTags({ result }: { result: ProviderCostResult }) {
  const plan = result.plan;
  if (!plan) return null;
  return (
    <>
      {plan.requiresDepositUsd != null && (
        <BadgeTip cls="" label={`deposit $${plan.requiresDepositUsd}`} title="Prepaid deposit required">
          {result.name}&apos;s {plan.name} plan needs a ${plan.requiresDepositUsd} minimum prepaid
          deposit before you can use it — not pay-as-you-go from $0.
        </BadgeTip>
      )}
      {plan.perCallUsd != null && (
        <BadgeTip cls="" label="per-call premium" title="Billed per request">
          {result.name} bills a per-call surcharge ({fmtPerUnit(plan.perCallUsd)}) on top of any
          subscription, rather than bundling calls into a credit allotment.
        </BadgeTip>
      )}
    </>
  );
}

/**
 * Who offers which streams, and from which plan tier — the tweet's "most restrict
 * gRPC/streaming" claim made scannable. Sourced from the streaming pricing data
 * (availability + the min-plan gate), not the live basket.
 */
// Availability columns. gRPC (Geyser / Yellowstone) and LaserStream are the same
// category — gRPC streaming — just branded differently (Helius ships gRPC as
// LaserStream), so they share one column here. The pricing model keeps them as
// separate billing axes (different $/GB), but availability is per-category.
const STREAM_AVAIL_COLS: { label: string; kinds: StreamKind[] }[] = [
  { label: "gRPC (Geyser / LaserStream)", kinds: ["geyser", "laserstream"] },
  { label: "WebSocket", kinds: ["websocket"] },
  { label: "Webhooks", kinds: ["webhook"] },
  // Pre-execution / shred: availability-only — never priced (see streaming.data.ts).
  { label: "Pre-execution / Shred", kinds: ["shred"] },
];

function StreamingRestrictions({ results }: { results: ProviderCostResult[] }) {
  return (
    <div className="prov-table-wrap">
      <table className="prov-table stream-restrict">
        <thead>
          <tr>
            <th>Provider</th>
            {STREAM_AVAIL_COLS.map((c) => (
              <th key={c.label}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const streams = streamingForProvider(r.providerId);
            const plans = plansForProvider(r.providerId);
            const brand = brandColorFor(r.providerId);
            return (
              <tr key={r.providerId}>
                <td className="text-fg" style={brand ? { color: brand } : undefined}>
                  {r.name}
                </td>
                {STREAM_AVAIL_COLS.map((col) => {
                  // All entries for this category — keep unavailable ones too, so the
                  // "via gRPC" state (available:false) can render its own badge.
                  const matches = streams.filter((x) => col.kinds.includes(x.kind));
                  const availableMatches = matches.filter((m) => m.available);

                  if (availableMatches.length > 0) {
                    // Offered, ungated, no override → plain "yes".
                    const ungated = availableMatches.find(
                      (m) => !m.availableFromPlanId && !m.availabilityStatus,
                    );
                    if (ungated) {
                      return (
                        <td key={col.label}>
                          <span className="badge good">yes</span>
                        </td>
                      );
                    }
                    // Offered but no public price (Triton Deshred) → "beta".
                    const beta = availableMatches.find((m) => m.availabilityStatus === "beta");
                    if (beta) {
                      return (
                        <td key={col.label}>
                          <BadgeTip cls="warn" label="beta" title="Beta">
                            {beta.note ?? `${col.label} is in beta.`}
                          </BadgeTip>
                        </td>
                      );
                    }
                    // Otherwise plan-gated → "{plan}+".
                    const gated = availableMatches[0];
                    const planName =
                      plans.find((p) => p.id === gated?.availableFromPlanId)?.name ?? "higher";
                    return (
                      <td key={col.label}>
                        <BadgeTip cls="warn" label={`${planName}+`} title="Plan-gated">
                          {gated?.note ??
                            `${col.label} is only available on ${r.name}'s ${planName} plan or higher.`}
                        </BadgeTip>
                      </td>
                    );
                  }

                  // Not a separate SKU, but the data folds into standard gRPC.
                  const viaGrpc = matches.find((m) => m.availabilityStatus === "via_grpc");
                  if (viaGrpc) {
                    return (
                      <td key={col.label}>
                        <BadgeTip cls="" label="via gRPC" title="Folds into gRPC">
                          {viaGrpc.note ??
                            "Not a separate product; the data feeds standard gRPC."}
                        </BadgeTip>
                      </td>
                    );
                  }

                  return (
                    <td key={col.label}>
                      <span className="badge bad">no</span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
