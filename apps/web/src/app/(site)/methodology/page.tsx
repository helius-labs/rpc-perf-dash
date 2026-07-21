import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import MethodExplorer from "./MethodExplorer";
import MethodologyToc, { type TocEntry } from "./MethodologyToc";
import ScoreFormulas from "./ScoreFormulas";
import { MethodologyCollapsible } from "./MethodologyCollapsible";

export const dynamic = "force-dynamic";

async function loadDoc(): Promise<string> {
  const candidates = [
    join(process.cwd(), "..", "..", "docs", "methodology.md"),
    join(process.cwd(), "docs/methodology.md"),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      // try next
    }
  }
  return "# Methodology\n\nFailed to load methodology.md";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Flatten React children (strings / nested elements) to plain text. */
function flatten(node: ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  if (typeof node === "object" && "props" in node) {
    return flatten((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

/**
 * Rewrite the raw markdown so the page can interleave React components:
 *  - the ASCII pipeline fence → a `[[PIPELINE]]` sentinel (+ extracted steps),
 *  - the wide "Projection & equivalence" table → a `[[METHOD_EXPLORER]]` sentinel.
 * Everything else stays markdown so the doc remains the source of truth.
 */
function preprocess(raw: string): { md: string; steps: string[] } {
  const lines = raw.split("\n");
  const out: string[] = [];
  let steps: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Strip the leading H1 — the hero renders the title.
    if (i === 0 && /^#\s+Methodology\s*$/.test(line)) continue;

    // Pipeline fence: ``` followed by a line containing "observe" + "→".
    if (line.trim() === "```" && lines[i + 1]?.includes("observe") && lines[i + 1]?.includes("→")) {
      let j = i + 1;
      const inner: string[] = [];
      while (j < lines.length && lines[j]!.trim() !== "```") {
        inner.push(lines[j]!);
        j++;
      }
      const arrowLine = inner.find((l) => l.includes("→")) ?? "";
      steps = arrowLine.split("→").map((s) => s.trim()).filter(Boolean);
      out.push("[[PIPELINE]]");
      i = j; // skip past the closing fence
      continue;
    }

    // Score-formula fence (first content line is "L = …") → the card grid.
    if (line.trim() === "```" && /^\s*L\s*=/.test(lines[i + 1] ?? "")) {
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() !== "```") j++;
      out.push("[[SCORE_FORMULAS]]");
      i = j; // skip past the closing fence
      continue;
    }

    // The "Projection & equivalence" table → Method Explorer.
    if (/^\|\s*Method\s*\|\s*Hashed/.test(line)) {
      let j = i;
      while (j < lines.length && lines[j]!.trimStart().startsWith("|")) j++;
      out.push("[[METHOD_EXPLORER]]");
      i = j - 1;
      continue;
    }

    out.push(line);
  }

  return { md: out.join("\n"), steps };
}

function tocFromDoc(raw: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const line of raw.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      const title = m[1]!.trim();
      entries.push({ slug: slugify(title), title });
    }
  }
  return entries;
}

const components: Components = {
  h2({ children }) {
    return <h2 id={slugify(flatten(children))}>{children}</h2>;
  },
  h3({ children }) {
    return <h3 id={slugify(flatten(children))}>{children}</h3>;
  },
};

function Pipeline({ steps }: { steps: string[] }) {
  if (!steps.length) return null;
  return (
    <ol className="list-none flex flex-wrap gap-2 m-0 mb-[22px] p-0" aria-label="End-to-end pipeline">
      {steps.map((s, i) => (
        <li
          className="inline-flex items-center gap-2 py-[7px] pr-[13px] pl-2 border border-line2 rounded-full bg-surface"
          key={s}
        >
          <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-[var(--accent-soft)] text-accent font-geistmono text-[10px] font-semibold">
            {i + 1}
          </span>
          <span className="font-geistmono text-[12px] tracking-[0.01em] text-fg capitalize">{s}</span>
        </li>
      ))}
    </ol>
  );
}

// Sections shown open by default; everything else collapses behind a toggle so
// the page is short up front but the depth is one click away.
const OPEN_SECTIONS = new Set([
  "Summary",
  "Goals",
  "How the system works",
  "Consensus decision rules",
]);

interface DocSection {
  title: string;
  slug: string;
  body: string;
}

/** Split the (preprocessed) doc into the lead intro + one block per `## `. */
function splitSections(md: string): { intro: string; sections: DocSection[] } {
  const intro: string[] = [];
  const sections: DocSection[] = [];
  let cur: { title: string; slug: string; body: string[] } | null = null;
  for (const line of md.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) sections.push({ title: cur.title, slug: cur.slug, body: cur.body.join("\n") });
      const title = m[1]!.trim();
      cur = { title, slug: slugify(title), body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      intro.push(line);
    }
  }
  if (cur) sections.push({ title: cur.title, slug: cur.slug, body: cur.body.join("\n") });
  return { intro: intro.join("\n"), sections };
}

/** Render a section body: markdown chunks + the injected interactive components. */
function renderBody(body: string, steps: string[]): ReactNode {
  return body.split(/(\[\[(?:METHOD_EXPLORER|PIPELINE|SCORE_FORMULAS)\]\])/).map((seg, i) => {
    if (seg === "[[METHOD_EXPLORER]]") {
      return (
        <div id="method-explorer" key="explorer">
          <MethodExplorer />
        </div>
      );
    }
    if (seg === "[[PIPELINE]]") return <Pipeline steps={steps} key="pipeline" />;
    if (seg === "[[SCORE_FORMULAS]]") return <ScoreFormulas key="score-formulas" />;
    if (!seg.trim()) return null;
    return (
      <article className="md-doc" key={i}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {seg}
        </ReactMarkdown>
      </article>
    );
  });
}

export default async function MethodologyPage() {
  const raw = await loadDoc();
  const { md, steps } = preprocess(raw);
  const toc = tocFromDoc(raw);
  const { intro, sections } = splitSections(md);

  const lastUpdated = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="pt-1">
      <header className="max-w-[820px]">
        <span className="section-kicker">Methodology</span>
        <h1 className="mt-2.5 mb-0 text-[clamp(30px,5vw,44px)] font-semibold tracking-[-0.03em] leading-[1.05] text-fg">
          How the benchmark works
        </h1>
        <p className="mt-3 font-geistmono text-[11px] uppercase tracking-[0.12em] text-muted">
          Last updated: {lastUpdated}
        </p>
        <p className="mt-4 text-[15.5px] leading-[1.6] text-fg2 max-w-[64ch]">
          A continuous, multi-region benchmark of public Solana RPC providers: how
          the queries, scoring, and consensus checks work, and how to read the
          numbers.
        </p>
      </header>

      <div className="grid grid-cols-[minmax(0,860px)] mt-8 min-[1120px]:grid-cols-[200px_minmax(0,820px)] min-[1120px]:gap-x-14">
        <aside className="hidden min-[1120px]:block">
          <MethodologyToc entries={toc} />
        </aside>

        <div>
          {intro.trim() && (
            <article className="md-doc">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {intro}
              </ReactMarkdown>
            </article>
          )}
          {sections.map((sec) =>
            OPEN_SECTIONS.has(sec.title) ? (
              <section key={sec.slug}>
                <h2 id={sec.slug} className="md-h2">
                  {sec.title}
                </h2>
                {renderBody(sec.body, steps)}
              </section>
            ) : (
              <MethodologyCollapsible key={sec.slug} title={sec.title} slug={sec.slug}>
                {renderBody(sec.body, steps)}
              </MethodologyCollapsible>
            ),
          )}
        </div>
      </div>

      <style>{mdStyles}</style>
    </div>
  );
}

/** Scoped styles for the rendered markdown. Server-rendered via <style>. */
const mdStyles = `
  /* Section heading (open sections) and collapsible toggles share one look. */
  .md-h2, .md-summary {
    font-size: 22px;
    margin: 40px 0 12px;
    color: #fff;
    font-weight: 600;
    border-bottom: 1px solid #1f1f1f;
    padding-bottom: 6px;
    scroll-margin-top: 24px;
  }
  .md-collapsible { margin: 0; }
  .md-summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    transition: color 0.15s ease;
  }
  .md-summary::-webkit-details-marker { display: none; }
  .md-summary:hover { color: #fff; }
  .md-summary[aria-expanded="true"] { color: #fff; }
  .md-collapsible-body { padding-top: 2px; }
  .md-doc h1 {
    font-size: 28px;
    margin: 8px 0 16px;
    color: #fff;
    font-weight: 700;
    border-bottom: 1px solid #2a2a2a;
    padding-bottom: 8px;
  }
  .md-doc h2 {
    font-size: 22px;
    margin: 40px 0 12px;
    color: #fff;
    font-weight: 600;
    border-bottom: 1px solid #1f1f1f;
    padding-bottom: 6px;
    scroll-margin-top: 24px;
  }
  .md-doc h3 {
    font-size: 17px;
    margin: 28px 0 8px;
    color: #eaeaea;
    font-weight: 600;
    scroll-margin-top: 24px;
  }
  .md-doc h4 {
    font-size: 15px;
    margin: 20px 0 6px;
    color: #ccc;
    font-weight: 600;
  }
  .md-doc p {
    margin: 0 0 14px;
    color: #cfcfcf;
  }
  .md-doc strong {
    color: #fff;
    font-weight: 600;
  }
  .md-doc em {
    color: #cfcfcf;
  }
  .md-doc a {
    color: #7cc6ff;
    text-decoration: none;
    border-bottom: 1px solid #2a3a4a;
  }
  .md-doc a:hover {
    border-bottom-color: #7cc6ff;
  }
  .md-doc ul, .md-doc ol {
    margin: 0 0 14px;
    padding-left: 24px;
  }
  .md-doc li {
    margin-bottom: 4px;
    color: #cfcfcf;
  }
  .md-doc li > p {
    margin: 0 0 4px;
  }
  .md-doc code {
    background: #1a1a1a;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #e0a878;
    border: 1px solid #2a2a2a;
  }
  .md-doc pre {
    background: #0e0e0e;
    border: 1px solid #1f1f1f;
    border-radius: 4px;
    padding: 12px 14px;
    overflow-x: auto;
    margin: 0 0 18px;
    font-size: 13px;
    line-height: 1.55;
  }
  .md-doc pre code {
    background: none;
    border: none;
    padding: 0;
    color: #d8d8d8;
  }
  .md-doc blockquote {
    border-left: 3px solid #f3c27a;
    background: #1f1808;
    padding: 10px 14px;
    margin: 0 0 18px;
    color: #f3d3a0;
    border-radius: 0 4px 4px 0;
  }
  .md-doc blockquote p {
    color: #f3d3a0;
    margin: 0;
  }
  .md-doc hr {
    border: none;
    border-top: 1px solid #2a2a2a;
    margin: 40px 0;
  }
  .md-doc table {
    margin: 0 0 20px;
    border: 1px solid #222;
    border-radius: 4px;
    overflow: hidden;
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    font-size: 13px;
  }
  .md-doc th {
    background: #161616;
    text-align: left;
    padding: 8px 12px;
    color: #ddd;
    font-weight: 600;
    border-bottom: 1px solid #2a2a2a;
  }
  .md-doc td {
    padding: 8px 12px;
    border-bottom: 1px solid #1a1a1a;
    color: #cfcfcf;
    vertical-align: top;
  }
  .md-doc tr:last-child td {
    border-bottom: none;
  }
  .md-doc tr:nth-child(even) td {
    background: #0e0e0e;
  }
  .md-doc table code {
    font-size: 12px;
  }
`;
