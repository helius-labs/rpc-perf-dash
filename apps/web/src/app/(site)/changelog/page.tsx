/**
 * Changelog — a simple dated timeline of notable updates.
 *
 * Add entries to ENTRIES (newest first) as the benchmark evolves. Each entry's
 * `tag` keys into TAG_COLORS for its pill color.
 */

import type { Metadata } from "next";
import { pageSeo } from "@/lib/seo";

// Static `metadata`, not generateMetadata — this page has no searchParams and
// no dynamic APIs, and keeping it a plain constant preserves its fully-static
// render (see the staleTimes.static note in next.config.ts).
export const metadata: Metadata = {
  title: "Changelog — Solana RPC Benchmark",
  description:
    "Dated log of notable changes to the Solana RPC benchmark: scoring updates, new methods and providers, and infrastructure changes.",
  ...pageSeo("/changelog"),
};

interface Entry {
  date: string;
  tag: keyof typeof TAG_COLORS;
  title: string;
  body: string;
}

const TAG_COLORS = {
  release: { bg: "#10261c", fg: "#6ee7b7" },
  ui: { bg: "#241524", fg: "#f59ec3" },
  scoring: { bg: "#241405", fg: "#f3c27a" },
  methods: { bg: "#0e2230", fg: "#7cc6ff" },
  infra: { bg: "#0e2a18", fg: "#7be0a4" },
  providers: { bg: "#1c1430", fg: "#a78bfa" },
  fix: { bg: "#2a1010", fg: "#f08080" },
} as const;

const ENTRIES: Entry[] = [
  {
    date: "2026-08-31",
    tag: "providers",
    title: "Quicknode rejoins the getTransactionsForAddress panel",
    body: "Quicknode's getTransactionsForAddress used to return a non-comparable shape (bare array instead of the {data, paginationToken} envelope, always-full details, slot pin ignored), so it couldn't vote. Re-probed live: all of that is fixed, and its answers are byte-equal with Helius and Alchemy across both buckets. The method goes from 2 voters back to 3 (Helius, Alchemy, Quicknode) — all three must answer and a 2-1 split is now decided with the deviator attributed. Second panel change for this method in August, after Triton dropped it on 2026-08-20. METHODOLOGY_VERSION stays at 4, so history is preserved: read a step in this method's correctness series as a rule change, not a provider regression.",
  },
  {
    date: "2026-08-20",
    tag: "providers",
    title: "Triton dropped getTransactionsForAddress",
    body: "Triton's endpoint began returning -32601 Method not found for getTransactionsForAddress, 100% of calls, while every other method on it stayed healthy. It's now declared unsupported for that method — scored on reliability, not marked wrong on a method its tier no longer serves. That took the panel to 2 voters and, for eleven days, made correctness there a pairwise byte-equal agreement check with no tie-breaker.",
  },
  {
    date: "2026-07-28",
    tag: "release",
    title: "1.2.0 — transaction-sending benchmark",
    body: "New Sends leaderboard (/sends): real transactions broadcast through each provider's standard endpoint and scored against the chain — landing rate and slot latency. Measures plain JSON-RPC sendTransaction across the 5 benchmarked providers (Helius, Alchemy, Triton, Quicknode, Chainstack) — no tips, no relays, apples-to-apples. Confirmation is a poll loop folded into the generator (getSignatureStatuses) — no separate service. Adds migration 0002 and a SENDS_ENABLED kill-switch. Additive: read scoring is unchanged. Versioned independently via SEND_METHODOLOGY_VERSION.",
  },
  {
    date: "2026-07-23",
    tag: "providers",
    title: "1.1.0 — Chainstack added",
    body: "Chainstack joins the benchmarked panel (now five: Helius, Triton, Alchemy, Quicknode, Chainstack). METHODOLOGY_VERSION bumped to 4 — adding a fifth voter changes getStakeMinimumDelegation's consensus rule from a relaxed 2-of-3 to the default 3-of-4 strict majority, so pre/post results are scored under different semantics and not blended.",
  },
  {
    date: "2026-07-17",
    tag: "release",
    title: "1.0.0 — first public release",
    body: "Open-source launch. Majority-consensus correctness across the benchmarked panel with honeypot spot-checks, ~45 read methods, per-region vantages, and a fully reproducible pipeline. Product releases follow semver from here; methodology changes are tracked separately in docs/methodology.md.",
  },
];

export default function ChangelogPage() {
  return (
    <div className="pt-1">
      <header className="max-w-[820px]">
        <span className="section-kicker">Changelog</span>
        <h1 className="mt-2.5 mb-0 text-[clamp(30px,5vw,44px)] font-semibold tracking-[-0.03em] leading-[1.05] text-fg">
          What&apos;s changed
        </h1>
        <p className="mt-4 text-[15.5px] leading-[1.6] text-fg2 max-w-[64ch]">
          Notable updates to the benchmark: scoring changes, new methods and
          vantages, and fixes.
        </p>
      </header>

      {ENTRIES.length === 0 ? (
        <p className="mt-9 max-w-[64ch] text-[14px] leading-[1.6] text-muted">
          No entries yet. Updates will appear here as the benchmark evolves.
        </p>
      ) : (
      <ol className="mt-9 max-w-[720px] list-none p-0 m-0">
        {ENTRIES.map((e) => {
          const c = TAG_COLORS[e.tag];
          return (
            <li key={e.date + e.title} className="relative border-l border-line pl-6 pb-8 last:pb-1">
              <span
                className="absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full bg-accent ring-4 ring-bg"
                aria-hidden="true"
              />
              <div className="flex items-center gap-3">
                <time className="font-geistmono text-[11.5px] tabular-nums text-muted">{e.date}</time>
                <span
                  className="inline-flex items-center rounded-full px-2 py-[2px] font-geistmono text-[10px] uppercase tracking-[0.1em]"
                  style={{ background: c.bg, color: c.fg }}
                >
                  {e.tag}
                </span>
              </div>
              <h3 className="mt-1.5 mb-0 text-[15.5px] font-semibold text-fg">{e.title}</h3>
              <p className="mt-1 mb-0 text-[13.5px] leading-[1.55] text-fg2">{e.body}</p>
            </li>
          );
        })}
      </ol>
      )}
    </div>
  );
}
