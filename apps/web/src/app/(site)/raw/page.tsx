import { sql } from "drizzle-orm";
import Link from "next/link";
import type { Route } from "next";
import { db, DB_ERROR_MESSAGE } from "@/lib/db";
import { Collapsible } from "./Collapsible";

export const dynamic = "force-dynamic";

// Shared styling so /raw matches the rest of the app (tokens + .prov-table).
const H2_CLS = "mt-10 mb-3 text-[20px] md:text-[22px] font-semibold tracking-[-0.022em] text-fg";
const PRE_CLS =
  "m-0 max-h-[360px] overflow-auto border-t border-line bg-bg px-3.5 py-3 font-geistmono text-[12px] leading-[1.5] text-fg2 whitespace-pre-wrap break-words";
const EMPTY_CLS = "border-t border-line px-3.5 py-3 text-[13px] text-muted";

/** Page header matching the other pages (section-kicker + hero title). */
function RawHeader({ title, subtitle }: { title: React.ReactNode; subtitle?: React.ReactNode }) {
  return (
    <header className="max-w-[820px] pt-1">
      <span className="section-kicker">Raw challenge</span>
      <h1 className="mt-2 mb-0 text-[clamp(26px,4vw,38px)] font-semibold tracking-[-0.026em] leading-[1.08] text-fg">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-3 mb-0 max-w-[64ch] text-[14px] leading-[1.6] text-fg2">{subtitle}</p>
      )}
    </header>
  );
}

// Note: postgres-js / Drizzle's `db.execute(sql...)` path returns raw rows
// without applying column-type parsers. Fields that are typed Date / Buffer /
// bigint in the schema may come back as strings or already-parsed natives
// depending on the postgres-js version. The render path defensively coerces.

interface ChallengeRow {
  id: string;
  method: string;
  params: unknown;
  bucket: string;
  commitment_hash: Buffer | string;
  seed: Buffer | string | null;
  seed_revealed_at: Date | string | null;
  generated_at: Date | string;
  expires_at: Date | string;
  reference_hash: Buffer | string | null;
  reference_response: unknown;
  reference_tip_slot: number | string | bigint | null;
  methodology_version: number;
  status: string;
  is_honeypot: boolean;
}

interface SampleRow {
  provider_id: string;
  region: string;
  egress_path: string;
  connection_mode: string;
  latency_ms: number;
  status: string;
  http_status: number | null;
  correctness: string;
  raw_response: unknown;
}

/** Consensus log row (per challenge × vantage × mode). */
interface ConsensusLogRow {
  worker_provider: string;
  region: string;
  egress_path: string;
  connection_mode: string;
  voters: unknown;
  decision: string;
  decision_reason: string | null;
  dissenters: unknown;
  decided_at: Date | string;
}

/** Coerce a Buffer-or-string-or-null bytea value to a hex string for display. */
function bytesToHex(v: Buffer | string | null | undefined): string {
  if (v == null) return "";
  if (Buffer.isBuffer(v)) return v.toString("hex");
  if (typeof v === "string") {
    // postgres can return bytea as `\x...` literal; strip the prefix.
    return v.startsWith("\\x") ? v.slice(2) : v;
  }
  return "";
}

/** Coerce a Date|string to an ISO string. */
function toIso(v: Date | string | null | undefined): string {
  if (v == null) return "—";
  if (v instanceof Date) return v.toISOString();
  return new Date(v).toISOString();
}

/** Render a bigint-or-numeric-string value as a string. */
function bigToStr(v: number | string | bigint | null | undefined): string {
  if (v == null) return "—";
  return String(v);
}

/** JSON.stringify that handles BigInt + Buffer in nested objects. */
function safeStringify(v: unknown): string {
  return JSON.stringify(
    v,
    (_key, value) => {
      if (typeof value === "bigint") return value.toString();
      if (value && typeof value === "object" && value.constructor?.name === "Buffer") {
        return `0x${(value as Buffer).toString("hex")}`;
      }
      return value;
    },
    2,
  );
}

export default async function RawPage({
  searchParams,
}: {
  searchParams: Promise<{ challenge?: string }>;
}) {
  const params = await searchParams;
  const id = params.challenge;
  if (!id) {
    return (
      <RawHeader
        title="Raw inspector"
        subtitle={
          <>
            Add <code>?challenge=&lt;uuid&gt;</code> to the URL to inspect a single challenge: its
            inputs, every provider&apos;s response, and the consensus verdict.
          </>
        }
      />
    );
  }

  // Basic UUID format validation — saves a noisy DB error if a typo is in the URL.
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (!looksLikeUuid) {
    return (
      <div>
        <RawHeader title="Raw inspector" />
        <div className="badge bad mt-6 block p-3">
          Invalid challenge ID: must be a UUID. Got: <code>{id}</code>
        </div>
      </div>
    );
  }

  let challenge: ChallengeRow | null = null;
  let samples: SampleRow[] = [];
  let consensus: ConsensusLogRow[] = [];
  let error: string | null = null;

  try {
    // Cast to ::uuid explicitly — postgres-js binds the param as text, which
    // postgres usually auto-coerces but isn't guaranteed across versions.
    const cRows = await db().execute(sql`SELECT * FROM challenges WHERE id = ${id}::uuid`);
    challenge = (cRows as unknown as ChallengeRow[])[0] ?? null;

    if (challenge) {
      const sRows = await db().execute(sql`
        SELECT provider_id, region, egress_path, connection_mode, latency_ms, status, http_status, correctness, raw_response
        FROM samples WHERE challenge_id = ${id}::uuid
        ORDER BY provider_id, connection_mode
      `);
      samples = sRows as unknown as SampleRow[];

      // Consensus log (per vantage × mode). For challenges whose
      // (vantage, mode) didn't trigger selective logging (healthy consensus
      // + not archive-sampled) there are simply no rows — that's expected,
      // not an error.
      const cnRows = await db().execute(sql`
        SELECT worker_provider, region, egress_path, connection_mode,
               voters, decision, decision_reason, dissenters, decided_at
        FROM consensus_log
        WHERE challenge_id = ${id}::uuid
        ORDER BY worker_provider, region, egress_path, connection_mode
      `);
      consensus = cnRows as unknown as ConsensusLogRow[];
    }
  } catch (err) {
    console.error("[/raw]", err);
    error = DB_ERROR_MESSAGE;
  }

  if (error) {
    return (
      <div>
        <RawHeader title="Raw inspector" />
        <div className="badge bad mt-6 block p-3">DB error: {error}</div>
      </div>
    );
  }
  if (!challenge) {
    return (
      <RawHeader
        title="Challenge not found"
        subtitle={<>No challenge with that ID. It may have aged out of retention.</>}
      />
    );
  }

  const seedRevealed = challenge.seed_revealed_at !== null;

  const meta: Array<[string, React.ReactNode, boolean?]> = [
    ["Method", <code key="m">{challenge.method}</code>],
    ["Bucket", <code key="b">{challenge.bucket}</code>],
    ["Honeypot", challenge.is_honeypot ? "yes" : "no"],
    ["Status", <code key="s">{challenge.status}</code>],
    ["Generated", toIso(challenge.generated_at)],
    ["Expires", toIso(challenge.expires_at)],
    ["Commitment hash", <code key="c">{bytesToHex(challenge.commitment_hash)}</code>, true],
    [
      "Seed",
      seedRevealed && challenge.seed ? (
        <code key="seed">{bytesToHex(challenge.seed)}</code>
      ) : (
        <span className="text-muted italic">not revealed yet</span>
      ),
      true,
    ],
    ["Reference tip slot", bigToStr(challenge.reference_tip_slot)],
  ];

  return (
    <div>
      <RawHeader
        title={<>Challenge {challenge.id.slice(0, 8)}</>}
        subtitle={
          <>
            Each challenge is tested from a few randomly-chosen vantage points (3 at a time, not the
            whole fleet), so you&apos;ll usually see up to 3 locations below. Over time, every vantage
            gets its turn.{" "}
            <Link href={"/methodology" as Route} className="text-accent hover:underline">
              How it works
            </Link>
          </>
        }
      />

      <div className="prov-table-wrap mt-6">
        <table className="prov-table" style={{ tableLayout: "fixed", width: "100%" }}>
          <colgroup>
            <col style={{ width: 180 }} />
            <col />
          </colgroup>
          <tbody>
            {meta.map(([label, value, wrap]) => (
              <tr key={label}>
                <td className="text-muted align-top">{label}</td>
                <td className="text-fg" style={{ wordBreak: wrap ? "break-all" : "normal" }}>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className={H2_CLS}>Params</h2>
      {seedRevealed ? (
        <ParamsCard method={challenge.method} params={challenge.params} />
      ) : (
        <p className="text-[13px] text-muted italic">Params are hidden until the challenge expires.</p>
      )}

      <Collapsible className="mt-3" title="Reference response">
        <pre className={PRE_CLS}>
          {!seedRevealed
            ? "Reference hidden until expiry."
            : challenge.reference_response == null
              ? "Reference payload trimmed 6h after generation to bound storage; the reference hash above is retained permanently."
              : safeStringify(challenge.reference_response)}
        </pre>
      </Collapsible>

      <Collapsible className="mt-3" title="Consensus log (per vantage × mode)" defaultOpen>
        {consensus.length > 0 ? (
          <pre className={PRE_CLS}>{safeStringify(consensus)}</pre>
        ) : (
          <p className={EMPTY_CLS}>
            No consensus-log entries. These are written selectively (no-consensus, or a 1%
            archive sample), so a healthy, non-sampled challenge produces no row.
          </p>
        )}
      </Collapsible>

      <h2 className={H2_CLS}>Per-provider samples ({samples.length})</h2>
      <PerProviderSamples samples={samples} />
    </div>
  );
}

/**
 * Render JSON-RPC params as a structured key/value table instead of a raw
 * JSON dump. The 3 methods we run all take a positional arg + an options
 * object, e.g.:
 *   getBlock                  : [slot, options]
 *   getTransaction            : [signature, options]
 *   getSignaturesForAddress   : [address, options]
 * For unknown formats we fall back to a pretty-printed JSON block.
 */
function ParamsCard({ method, params }: { method: string; params: unknown }) {
  const arr = Array.isArray(params) ? (params as unknown[]) : null;
  if (!arr || arr.length === 0) {
    return (
      <pre className="m-0 overflow-auto rounded-lg border border-line bg-bg px-3.5 py-3 font-geistmono text-[12px] leading-[1.5] text-fg2 whitespace-pre-wrap break-words">
        {safeStringify(params)}
      </pre>
    );
  }

  const PRIMARY_LABEL: Record<string, string> = {
    getBlock: "slot",
    getTransaction: "signature",
    getSignaturesForAddress: "address",
  };
  const primaryLabel = PRIMARY_LABEL[method] ?? "arg";
  const primary = arr[0];
  const options = arr.length > 1 && arr[1] && typeof arr[1] === "object" && !Array.isArray(arr[1])
    ? (arr[1] as Record<string, unknown>)
    : null;

  const formatValue = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
    return JSON.stringify(v);
  };

  return (
    <div className="prov-table-wrap">
      <table className="prov-table" style={{ tableLayout: "fixed", width: "100%" }}>
        <colgroup>
          <col style={{ width: 160 }} />
          <col />
        </colgroup>
        <tbody>
          <tr>
            <td className="align-top text-muted">{primaryLabel}</td>
            <td className="align-top text-fg" style={{ wordBreak: "break-all" }}>
              <code>{formatValue(primary)}</code>
            </td>
          </tr>
          {options && Object.entries(options).map(([k, v]) => (
            <tr key={k}>
              <td className="align-top text-muted pl-6">
                <span className="opacity-60">options.</span>{k}
              </td>
              <td className="align-top text-fg" style={{ wordBreak: "break-all" }}>
                <code>{formatValue(v)}</code>
              </td>
            </tr>
          ))}
          {arr.length > 2 && (
            <tr>
              <td colSpan={2} className="text-[11px] text-muted italic">
                + {arr.length - 2} additional arg{arr.length - 2 === 1 ? "" : "s"} (rare; raw JSON below)
                <pre className="mt-1.5 mb-0 overflow-auto rounded-md border border-line bg-bg px-2.5 py-2 font-geistmono text-[11px] not-italic text-fg2 whitespace-pre-wrap break-words">
                  {safeStringify(arr.slice(2))}
                </pre>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Per-provider samples view. Each provider's rows are grouped into a
 * collapsible <details> block so the user can fold a provider away when
 * they don't care about it. Default open. Native HTML — no client JS.
 */
function PerProviderSamples({ samples }: { samples: SampleRow[] }) {
  if (samples.length === 0) {
    return <p className="text-[13px] text-muted">No samples for this challenge.</p>;
  }

  // Group by provider, then sort each group's rows by (region, egress, mode).
  const groups = new Map<string, SampleRow[]>();
  for (const s of samples) {
    const arr = groups.get(s.provider_id) ?? [];
    arr.push(s);
    groups.set(s.provider_id, arr);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      if (a.region !== b.region) return a.region.localeCompare(b.region);
      if (a.egress_path !== b.egress_path) return a.egress_path.localeCompare(b.egress_path);
      return a.connection_mode.localeCompare(b.connection_mode);
    });
  }
  const orderedProviders = [...groups.keys()].sort();

  return (
    <div className="flex flex-col gap-2">
      {orderedProviders.map((provider) => {
        const rows = groups.get(provider)!;
        return (
          <Collapsible
            key={provider}
            defaultOpen
            title={
              <>
                <span className="text-[13px] font-semibold text-fg">{provider}</span>
                <span className="ml-2 text-muted">· {rows.length} samples</span>
              </>
            }
          >
            <div className="prov-table-wrap px-3.5">
              <table className="prov-table" style={{ tableLayout: "fixed", width: "100%", minWidth: 720 }}>
                <colgroup>
                  <col style={{ width: 210 }} />
                  <col style={{ width: 70 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 70 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 110 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Vantage</th>
                    <th>Mode</th>
                    <th className="prov-num">Latency</th>
                    <th>Status</th>
                    <th className="prov-num">HTTP</th>
                    <th>Correctness</th>
                    <th>Raw archived?</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s, i) => (
                    <tr key={i}>
                      <td>
                        <span className="prov-ch-method">{s.region}</span>{" "}
                        <span className="text-muted">· {s.egress_path}</span>
                      </td>
                      <td>{s.connection_mode}</td>
                      <td className="prov-num">
                        {s.latency_ms}
                        <span className="text-muted">ms</span>
                      </td>
                      <td>{s.status}</td>
                      <td className="prov-num">{s.http_status ?? "—"}</td>
                      <td>{s.correctness}</td>
                      <td>{s.raw_response ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Collapsible>
        );
      })}
    </div>
  );
}
