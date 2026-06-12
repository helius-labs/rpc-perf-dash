/**
 * Changelog — a simple dated timeline of notable updates.
 *
 * Add entries to ENTRIES (newest first) as the benchmark evolves. Each entry's
 * `tag` keys into TAG_COLORS for its pill color.
 */

interface Entry {
  date: string;
  tag: keyof typeof TAG_COLORS;
  title: string;
  body: string;
}

const TAG_COLORS = {
  ui: { bg: "#241524", fg: "#f59ec3" },
  scoring: { bg: "#241405", fg: "#f3c27a" },
  methods: { bg: "#0e2230", fg: "#7cc6ff" },
  infra: { bg: "#0e2a18", fg: "#7be0a4" },
  providers: { bg: "#1c1430", fg: "#a78bfa" },
  fix: { bg: "#2a1010", fg: "#f08080" },
} as const;

const ENTRIES: Entry[] = [];

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
