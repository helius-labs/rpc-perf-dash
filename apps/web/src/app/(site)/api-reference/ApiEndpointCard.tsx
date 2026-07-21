"use client";

/**
 * One collapsible endpoint card for the API reference. Reuses the methodology
 * page's grid-rows slide + opacity-fade reveal (see MethodologyCollapsible) so
 * the open/close is animated, plus a Request/Response tab toggle for the code
 * panel. Pure presentation — all data arrives as serializable props from the
 * server page.
 */

import { useState } from "react";

export interface ApiParam {
  name: string;
  values: string;
  def: string;
}

export interface ApiEndpoint {
  method: string;
  path: string;
  slug: string;
  blurb: string;
  params: ApiParam[];
  example: string;
  response: string;
}

export default function ApiEndpointCard({
  endpoint,
  origin,
  defaultOpen = false,
}: {
  endpoint: ApiEndpoint;
  origin: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { method, path, slug, blurb, params, example, response } = endpoint;

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
          {method}
        </span>
        <code className="font-geistmono text-[14.5px] text-fg">{path}</code>
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

            <CodePanel origin={origin} example={example} response={response} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CodePanel({
  origin,
  example,
  response,
}: {
  origin: string;
  example: string;
  response: string;
}) {
  const [tab, setTab] = useState<"request" | "response">("response");
  const curl = `curl "${origin}${example}"`;

  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center gap-1">
        <TabButton active={tab === "request"} onClick={() => setTab("request")}>
          Request
        </TabButton>
        <TabButton active={tab === "response"} onClick={() => setTab("response")}>
          Response
        </TabButton>
      </div>
      {tab === "request" ? <CodeBlock text={curl} /> : <CodeBlock text={response} />}
    </div>
  );
}

export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-md px-2.5 py-1 font-geistmono text-[11px] uppercase tracking-[0.08em] transition-colors " +
        (active ? "bg-surface text-fg" : "text-muted hover:text-fg2")
      }
    >
      {children}
    </button>
  );
}

export function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-line bg-surface px-4 py-3 font-geistmono text-[12px] leading-[1.65] text-fg2">
        <code>{text}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 rounded-md border border-line bg-bg px-2 py-0.5 font-geistmono text-[10px] uppercase tracking-[0.08em] text-muted transition-colors hover:text-fg"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
