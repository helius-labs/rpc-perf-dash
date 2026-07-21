"use client";

/**
 * One collapsible embed-widget card for the API reference § Embeds. Same
 * open/close reveal + code panel as ApiEndpointCard, but the code tabs show the
 * ready-to-paste <iframe> snippet and the raw embed URL instead of curl/JSON.
 * Pure presentation — all data arrives as serializable props from the server.
 */

import { useState } from "react";
import { CodeBlock, TabButton } from "./ApiEndpointCard";

export interface EmbedParam {
  name: string;
  values: string;
  def: string;
}

export interface EmbedWidget {
  /** URL segment under /embed (e.g. "chart"). */
  id: string;
  slug: string;
  title: string;
  blurb: string;
  params: EmbedParam[];
  /** Query string appended to the example (no leading `?`), or "". */
  exampleQuery: string;
}

/** Build the ready-to-paste iframe snippet for a widget + example query. */
function iframeSnippet(origin: string, id: string, query: string, title: string): string {
  const src = `${origin}/embed/${id}${query ? `?${query}` : ""}`;
  return `<iframe
  src="${src}"
  title="${title}"
  style="width:100%;border:0"
  scrolling="no"
  loading="lazy"
></iframe>`;
}

export default function EmbedWidgetCard({
  widget,
  origin,
  defaultOpen = false,
}: {
  widget: EmbedWidget;
  origin: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<"embed" | "url">("embed");
  const { id, slug, title, blurb, params, exampleQuery } = widget;

  const url = `${origin}/embed/${id}${exampleQuery ? `?${exampleQuery}` : ""}`;
  const snippet = iframeSnippet(origin, id, exampleQuery, `Solana RPC Benchmark — ${title}`);

  return (
    <div className="border-t border-line">
      <button
        type="button"
        id={slug}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 bg-transparent py-4 text-left scroll-mt-6 hover:no-underline"
      >
        <span className="rounded bg-surface px-1.5 py-0.5 font-geistmono text-[11px] font-semibold text-fg2">
          IFRAME
        </span>
        <code className="font-geistmono text-[14.5px] text-fg">/embed/{id}</code>
        <span className="text-[13px] text-muted max-[640px]:hidden">{title}</span>
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          className={"ml-auto shrink-0 text-muted transition-transform " + (open ? "rotate-180" : "")}
        >
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div
        className={
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none " +
          (open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
        }
      >
        <div
          className={
            "overflow-hidden transition-opacity duration-300 ease-out " +
            (open ? "opacity-100" : "opacity-0")
          }
        >
          <div className="pb-7">
            <p className="text-[14px] leading-[1.6] text-fg2">{blurb}</p>

            {params.length > 0 && (
              <dl className="mt-5 divide-y divide-line rounded-lg border border-line">
                {params.map((p) => (
                  <div
                    key={p.name}
                    className="grid grid-cols-[150px_minmax(0,1fr)] gap-4 px-4 py-3 max-[640px]:grid-cols-1 max-[640px]:gap-1"
                  >
                    <dt className="flex flex-col gap-1">
                      <code className="font-geistmono text-[13px] text-fg">{p.name}</code>
                      <span className="font-geistmono text-[10px] uppercase tracking-[0.08em] text-muted">
                        default: {p.def}
                      </span>
                    </dt>
                    <dd className="text-[13px] leading-[1.55] text-fg2">{p.values}</dd>
                  </div>
                ))}
              </dl>
            )}

            <div className="mt-5">
              <div className="mb-2 flex items-center gap-1">
                <TabButton active={tab === "embed"} onClick={() => setTab("embed")}>
                  Embed
                </TabButton>
                <TabButton active={tab === "url"} onClick={() => setTab("url")}>
                  URL
                </TabButton>
              </div>
              {tab === "embed" ? <CodeBlock text={snippet} /> : <CodeBlock text={url} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
