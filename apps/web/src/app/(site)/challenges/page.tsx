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
 *   ?status=<status>          ready | expired
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
import type { Metadata, Route } from "next";
import { unstable_cache } from "next/cache";
import { db, DB_ERROR_MESSAGE } from "@/lib/db";
import { type Method } from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { buildPageUrl } from "@/lib/apiParams";
import { pageSeo } from "@/lib/seo";
import { FilterPill } from "@/components/FilterPill";
import { FilterGroup } from "@/components/FilterGroup";
import { MethodFilter } from "@/components/MethodFilter";
import { BucketFilter } from "@/components/BucketFilter";
import { BucketLegend } from "@/components/BucketLegend";
import { ChallengesTable } from "@/components/ChallengesTable";
import { SendTxnsTable } from "@/components/SendTxnsTable";
import {
  MAX_TARGET_LEN,
  PAGE_SIZE,
  STATUS_OPTIONS,
  SEND_OUTCOME_OPTIONS,
  parseChallengesFilters,
  type ChallengeRow,
  type ChallengesFiltersNoOffset,
} from "@/lib/challengeFilters";
import { fetchChallengeRows, whereFor } from "@/lib/challengeRows";
import {
  fetchSendTxnRows,
  fetchSendTxnCount,
  fetchScenarioOptions,
  type SendTxnRow,
} from "@/lib/sendTxns";
import { scenarioLabel } from "@/lib/sendLabels";

export const dynamic = "force-dynamic";

interface SearchParams {
  board?: string;
  method?: string;
  bucket?: string;
  status?: string;
  scenario?: string;
  outcome?: string;
  window?: string;
  target?: string;
  offset?: string;
}

// Every filter here is a query param, so the permutation count is effectively
// unbounded — this page was the biggest source of junk indexed URLs. pageSeo()
// indexes the bare /challenges and noindexes every ?bucket=/?board=/?offset=…
// variant while pointing each back at the clean path.
//
// Caveat worth knowing: ?offset= pagination also canonicalizes to page 1, which
// runs against Google's self-canonical advice for paginated listings. Harmless
// while those URLs are noindex anyway; revisit if paginated challenge URLs ever
// need to rank.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const params = await searchParams;
  return {
    title: "Challenge feed — Solana RPC Benchmark",
    description:
      "Browse the sealed challenges driving the benchmark: method, bucket, target and consensus outcome for every recent request.",
    ...pageSeo("/challenges", params),
  };
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
  return buildPageUrl("/challenges", params, override);
}

export default async function ChallengesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = parseChallengesFilters(params);
  const { board, method, bucket: effectiveBucket, status, scenario, outcome, window, target, offset } =
    filters;

  // ── Query ─────────────────────────────────────────────────────────────
  // Bucket vocabulary is queried from the DB (in the fetcher) rather than
  // imported from @rpcbench/methods so the web app stays free of the runner-side
  // dependency, and so the dropdown reflects what actually exists in the table
  // for the chosen window. The Sends board reads landing_tx_results instead of
  // challenges (see lib/sendTxns.ts); only one board's queries run per request.
  let rows: ChallengeRow[] = [];
  let sendRows: SendTxnRow[] = [];
  let totalMatching = 0;
  let bucketOptions: string[] = [];
  let scenarioOptions: string[] = [];
  let error: string | null = null;
  try {
    if (board === "sends") {
      [sendRows, totalMatching, scenarioOptions] = await Promise.all([
        fetchSendTxnRows(filters),
        fetchSendTxnCount(filters),
        fetchScenarioOptions(window),
      ]);
    } else {
      // Split so paging (offset-only change) re-runs just the row query; the count
      // and bucket-vocabulary queries are cached on offset-independent keys.
      [rows, totalMatching, bucketOptions] = await Promise.all([
        fetchChallengeRows(filters),
        fetchChallengeCount({ board, method, bucket: effectiveBucket, status, scenario, outcome, window, target }),
        fetchBucketOptions({ method, window }),
      ]);
    }
  } catch (err) {
    console.error("[/challenges]", err);
    error = DB_ERROR_MESSAGE;
  }

  // ── Render ────────────────────────────────────────────────────────────
  // Pager — Prev / "Page P of N" / Next, shown above and below the table.
  const activeRowCount = board === "sends" ? sendRows.length : rows.length;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(totalMatching / PAGE_SIZE));
  const hasPrev = offset > 0;
  const hasNext = offset + activeRowCount < totalMatching;
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
          {board === "sends" ? (
            <>
              Every transaction the send lane broadcast in the selected window, scored against
              the chain. Click a signature to open it on Orb. Toggle back to <strong>RPC</strong>{" "}
              for read challenges.
            </>
          ) : (
            <>
              Filter and browse every challenge generated in the selected window. Click any row to
              open <code>/raw</code> for the full per-vantage consensus log. Toggle to{" "}
              <strong>Sends</strong> for the transaction-send txns.
            </>
          )}
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
        {/* Board toggle — RPC read challenges vs the transaction-send txns.
            Same page, no dropdown/separate route. Switching clears the other
            board's filters + the pagination offset. */}
        <FilterGroup label="Board">
          <FilterPill
            active={board === "rpcs"}
            href={urlWith(params, { board: null, scenario: null, outcome: null, offset: null })}
          >
            RPC
          </FilterPill>
          <FilterPill
            active={board === "sends"}
            href={urlWith(params, { board: "sends", method: null, bucket: null, status: null, offset: null })}
          >
            Sends
          </FilterPill>
        </FilterGroup>

        {board === "rpcs" ? (
          <>
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
          </>
        ) : (
          <>
            {scenarioOptions.length > 0 && (
              <FilterGroup label="Scenario">
                <FilterPill
                  active={scenario === null}
                  href={urlWith(params, { scenario: null, offset: null })}
                >
                  All
                </FilterPill>
                {scenarioOptions.map((s) => (
                  <FilterPill
                    key={s}
                    active={s === scenario}
                    href={urlWith(params, { scenario: s, offset: null })}
                  >
                    {scenarioLabel(s)}
                  </FilterPill>
                ))}
              </FilterGroup>
            )}

            <FilterGroup label="Outcome">
              <FilterPill active={outcome === null} href={urlWith(params, { outcome: null, offset: null })}>
                All
              </FilterPill>
              {SEND_OUTCOME_OPTIONS.map((o) => (
                <FilterPill
                  key={o.value}
                  active={o.value === outcome}
                  href={urlWith(params, { outcome: o.value, offset: null })}
                >
                  {o.label}
                </FilterPill>
              ))}
            </FilterGroup>
          </>
        )}

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
      <form action="/challenges" method="get" className="flex items-center gap-2 mb-4">
        {/* Preserve other filters across submits via hidden inputs. */}
        {board === "sends" && <input type="hidden" name="board" value="sends" />}
        {method && <input type="hidden" name="method" value={method} />}
        {effectiveBucket && <input type="hidden" name="bucket" value={effectiveBucket} />}
        {status && <input type="hidden" name="status" value={status} />}
        {scenario && <input type="hidden" name="scenario" value={scenario} />}
        {outcome && <input type="hidden" name="outcome" value={outcome} />}
        <input type="hidden" name="window" value={String(window)} />
        <label
          htmlFor="target-search"
          className="font-geistmono text-[11px] text-muted uppercase tracking-[0.6px]"
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
            className="text-[11px] text-muted underline"
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
                  {offset + 1}–{Math.min(offset + activeRowCount, totalMatching)}
                </span>
              )}
            </>
          )}
        </div>
        {pager}
      </div>

      {/* Results table. RPC board = live-polling ChallengesTable; Sends board =
          the send-txn record (SendTxnsTable), server-rendered. */}
      {!error &&
        (board === "sends" ? (
          <SendTxnsTable
            rows={sendRows}
            emptyText={`No send txns match this filter in the last ${WINDOWS.find((w) => w.value === window)?.label ?? `${window}h`}.`}
          />
        ) : (
          <ChallengesTable
            initial={rows}
            filters={filters}
            emptyText={`No challenges match this filter in the last ${WINDOWS.find((w) => w.value === window)?.label ?? `${window}h`}.`}
          />
        ))}

      {pager && <div className="mt-3 flex justify-end">{pager}</div>}
    </div>
  );
}
