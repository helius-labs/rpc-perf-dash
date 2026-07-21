import type { ReactNode } from "react";
import type { Metadata } from "next";
import EmbedAutoResize from "@/components/EmbedAutoResize";
import { siteUrl } from "@/lib/siteUrl";

// Embeds are framed on external landing pages — keep them out of search so they
// don't compete with the canonical dashboard pages (mirrors /api-reference).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Bare, chromeless wrapper: no nav, no width cap. A small attribution link back
// to the full dashboard opens in the top window (marketing + backlink value).
export default function EmbedLayout({ children }: { children: ReactNode }) {
  return (
    // The auto-resize measures THIS element's own box height (id below) rather
    // than the document/viewport — so the iframe both grows AND shrinks with the
    // content (e.g. when the filter panel collapses). Its height must track the
    // content, so keep it a plain block (no min-height / 100vh).
    <div id="rpcbench-embed-root" className="bg-bg text-fg p-3 max-[640px]:p-2">
      {children}
      <div className="mt-3 text-right">
        <a
          href={siteUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="font-geistmono text-[10px] text-muted hover:text-fg hover:no-underline"
        >
          Powered by Solana RPC Benchmark ↗
        </a>
      </div>
      <EmbedAutoResize />
    </div>
  );
}
