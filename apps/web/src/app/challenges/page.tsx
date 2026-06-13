/**
 * /challenges — filterable browse of recent challenges.
 *
 * Server-rendered. All filter state lives in URL query params so links are
 * bookmarkable, shareable, and the browser back button works. No client JS
 * needed beyond the existing FilterPill / ChallengeTarget components.
 *
 * Filters:
 *   ?method=<method>          single method, or absent for all
 *   ?bucket=<bucket>          single bucket, or absent for all
 *   ?status=<status>          ready | expired | (legacy: ambiguous | pending_quorum)
 *   ?window=<hours>           1 / 6 / 24 / 168 / 720 — relative window from now
 *   ?target=<substring>       case-insensitive substring match on params (JSON-stringified)
 *   ?honeypots=1              include honeypots (default: excluded)
 *   ?offset=<n>               pagination offset
 *
 * Always sorted by generated_at DESC; that's the only ordering anyone wants
 * here in practice.
 */

import { sql } from "drizzle-orm";
import Link from "next/link";
import type { Route } from "next";
import { unstable_cache } from "next/cache";
import { db, DB_ERROR_MESSAGE } from "@/lib/db";
import { type Method } from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { FilterPill } from "@/components/FilterPill";
import { FilterGroup } from "@/components/FilterGroup";
import { MethodFilter } from "@/components/MethodFilter";
import { BucketFilter } from "@/components/BucketFilter";
import { BucketLegend } from "@/components/BucketLegend";
import { ChallengesTable } from "@/components/ChallengesTable";
import {
  MAX_TARGET_LEN,
  PAGE_SIZE,
  STATUS_OPTIONS,
  parseChallengesFilters,
  type ChallengeRow,
  type ChallengesFiltersNoOffset,
} from "@/lib/challengeFilters";
import { fetchChallengeRows, whereFor } from "@/lib/challengeRows";

export const dynamic = "force-dynamic";

interface SearchParams {
  method?: string;
  bucket?: string;
  status?: string;
  window?: string;
  target?: string;
  offset?: string;
}

/** Total matching count — offset-independent, so it's reused across pages. */
async function fetchChallengeCountImpl(f: ChallengesFiltersNoOffset): Promise<number> {
  const rows = await db().execute(sql`SELECT count(*)::int AS n FROM challenges c ${whereFor(f)}`);
  return (rows as unknown as Array<{ n: number }>)[0]?.n ?? 0;
}
const fetchChallengeCount = unstable_cache(fetchChallengeCountImpl, ["challengeCount"], {
  revalidate: 15,
});

/**
 * Bucket vocabulary for the dropdown — depends only on (window, method), so it's
 * cached separately and never re-runs when paging or changing status/target.
 */
async function fetchBucketOptionsImpl(f: { method: Method | null; window: number }): Promise<string[]> {
  const where = sql`WHERE ${sql.join(
    [
      sql`c.generated_at > now() - make_interval(hours => ${f.window})`,
      f.method ? sql`c.method = ${f.method}` : null,
      sql`c.is_honeypot = false`,
    ].filter((x): x is NonNullable<typeof x> => x !== null),
    sql` AND `,
  )}`;
  const rows = await db().execute(sql`SELECT DISTINCT bucket FROM challenges c ${where} ORDER BY bucket`);
  return (rows as unknown as Array<{ bucket: string }>).map((r) => r.bucket);
}
const fetchBucketOptions = unstable_cache(fetchBucketOptionsImpl, ["challengeBuckets"], {
  revalidate: 30,
});

function urlWith(
  params: SearchParams,
  override: Partial<Record<keyof SearchParams, string | null>>,
): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v != null) merged[k] = String(v);
  for (const [k, v] of Object.entries(override)) {
    if (v === null) delete merged[k];
    else if (v != null) merged[k] = String(v);
  }
  const qs = new URLSearchParams(merged).toString();
  return qs ? `/challenges?${qs}` : "/challenges";
}

export default async function ChallengesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = parseChallengesFilters(params);
  const { method, bucket: effectiveBucket, status, window, target, offset } = filters;

  // ── Query ─────────────────────────────────────────────────────────────
  // Bucket vocabulary is queried from the DB (in the fetcher) rather than
  // imported from @rpcbench/methods so the web app stays free of the runner-side
  // dependency, and so the dropdown reflects what actually exists in the table
  // for the chosen window.
  let rows: ChallengeRow[] = [];
  let totalMatching = 0;
  let bucketOptions: string[] = [];
  let error: string | null = null;
  try {
    // Split so paging (offset-only change) re-runs just the row query; the count
    // and bucket-vocabulary queries are cached on offset-independent keys.
    [rows, totalMatching, bucketOptions] = await Promise.all([
      fetchChallengeRows(filters),
      fetchChallengeCount({ method, bucket: effectiveBucket, status, window, target }),
      fetchBucketOptions({ method, window }),
    ]);
  } catch (err) {
    console.error("[/challenges]", err);
    error = DB_ERROR_MESSAGE;
  }

  // ── Render ────────────────────────────────────────────────────────────
  // Pager — Prev / "Page P of N" / Next, shown above and below the table.
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(totalMatching / PAGE_SIZE));
  const hasPrev = offset > 0;
  const hasNext = offset + rows.length < totalMatching;
  const pagerBtn =
    "inline-flex items-center gap-1 rounded-full border px-3 py-[5px] font-geistmono text-[11.5px] transition-colors";
  const pager =
    totalMatching > PAGE_SIZE ? (
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Link
            href={urlWith(params, { offset: String(Math.max(0, offset - PAGE_SIZE)) }) as Route}
            className={`${pagerBtn} border-line2 text-fg2 hover:text-fg hover:border-fg2`}
          >
            ← Prev
          </Link>
        ) : (
          <span className={`${pagerBtn} border-line text-muted opacity-40 cursor-default`}>← Prev</span>
        )}
        <span className="font-geistmono text-[11.5px] text-muted px-1 tabular-nums">
          Page {page} of {totalPages.toLocaleString()}
        </span>
        {hasNext ? (
          <Link
            href={urlWith(params, { offset: String(offset + PAGE_SIZE) }) as Route}
            className={`${pagerBtn} border-line2 text-fg2 hover:text-fg hover:border-fg2`}
          >
            Next →
          </Link>
        ) : (
          <span className={`${pagerBtn} border-line text-muted opacity-40 cursor-default`}>Next →</span>
        )}
      </div>
    ) : null;

  return (
    <div>
      <header className="max-w-[820px] pt-1">
        <span className="section-kicker">Challenges</span>
        <h1 className="text-[clamp(26px,4vw,38px)] font-semibold tracking-[-0.025em] leading-[1.08] mt-2 mb-0 text-fg">
          Recent challenges
        </h1>
        <p className="mt-3 mb-5 text-[14.5px] leading-[1.6] text-fg2 max-w-[64ch]">
          Filter and browse every challenge generated in the selected window. Click any row to
          open <code>/raw</code> for the full per-vantage consensus log.
        </p>
      </header>

      {/* Filter bar — clean border-y row, matching the Overview/Performance control bars. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          padding: "12px 0",
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          marginBottom: 16,
        }}
      >
        <FilterGroup label="Method">
          {/* Dropdown (like the leaderboard chart filter) — the method set is
              now 37, too many for a flat pill row. "All" clears the filter;
              methods are listed alphabetically. Changing method also resets the
              bucket + pagination offset. */}
          <MethodFilter
            options={[
              { method: "All", href: urlWith(params, { method: null, bucket: null, offset: null }) },
              ...[...ALL_METHODS]
                .sort((a, b) => a.localeCompare(b))
                .map((m) => ({
                  method: m,
                  href: urlWith(params, { method: m, bucket: null, offset: null }),
                })),
            ]}
            selected={method ?? "All"}
          />
        </FilterGroup>

        {bucketOptions.length > 0 && (
          <div className="flex items-center gap-1.5 min-w-0 max-md:w-full">
            <FilterGroup label="Bucket">
              <BucketFilter
                options={bucketOptions}
                selected={effectiveBucket}
                hrefFor={(b) => urlWith(params, { bucket: b, offset: null })}
              />
            </FilterGroup>
            <BucketLegend />
          </div>
        )}

        <FilterGroup label="Status">
          <FilterPill active={status === null} href={urlWith(params, { status: null, offset: null })}>
            All
          </FilterPill>
          {STATUS_OPTIONS.map((s) => (
            <FilterPill
              key={s.value}
              active={s.value === status}
              href={urlWith(params, { status: s.value, offset: null })}
            >
              {s.label}
            </FilterPill>
          ))}
        </FilterGroup>

        <FilterGroup label="Window">
          {WINDOWS.map((w) => (
            <FilterPill
              key={w.value}
              active={w.value === window}
              href={urlWith(params, { window: String(w.value), offset: null })}
            >
              {w.label}
            </FilterPill>
          ))}
        </FilterGroup>
      </div>

      {/* Target search — server-rendered form GETs back to /challenges */}
      <form action="/challenges" method="get" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        {/* Preserve other filters across submits via hidden inputs. */}
        {method && <input type="hidden" name="method" value={method} />}
        {effectiveBucket && <input type="hidden" name="bucket" value={effectiveBucket} />}
        {status && <input type="hidden" name="status" value={status} />}
        <input type="hidden" name="window" value={String(window)} />
        <label
          htmlFor="target-search"
          style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6 }}
        >
          Parameter filter
        </label>
        <input
          id="target-search"
          name="target"
          defaultValue={target}
          maxLength={MAX_TARGET_LEN}
          placeholder="signature, address, or slot"
          style={{
            flex: 1,
            minWidth: 280,
            background: "var(--bg)",
            border: "1px solid var(--border-2)",
            borderRadius: 4,
            padding: "5px 10px",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        />
        <button
          type="submit"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border-2)",
            color: "var(--text)",
            borderRadius: 4,
            padding: "5px 14px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Search
        </button>
        {target && (
          <Link
            href={urlWith(params, { target: null, offset: null }) as Route}
            style={{ fontSize: 11, color: "var(--muted)", textDecoration: "underline" }}
          >
            clear
          </Link>
        )}
      </form>

      {/* Result summary + pager */}
      <div className="flex items-center justify-between gap-4 mb-2 flex-wrap">
        <div className="font-geistmono text-[11.5px] text-muted">
          {error ? (
            <span style={{ color: "#f08080" }}>DB error: {error}</span>
          ) : (
            <>
              {totalMatching.toLocaleString()} match{totalMatching === 1 ? "" : "es"}
              {totalMatching > 0 && (
                <span className="text-fg2">
                  {" · "}
                  {offset + 1}–{Math.min(offset + rows.length, totalMatching)}
                </span>
              )}
            </>
          )}
        </div>
        {pager}
      </div>

      {/* Results table — client component that polls /api/challenges with the
          active filters, exactly like RecentChallengesTable on /performance. */}
      {!error && (
        <ChallengesTable
          initial={rows}
          filters={filters}
          emptyText={`No challenges match this filter in the last ${WINDOWS.find((w) => w.value === window)?.label ?? `${window}h`}.`}
        />
      )}

      {pager && <div className="mt-3 flex justify-end">{pager}</div>}
    </div>
  );
}
