import type { ReactNode } from "react";
import type { Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
import { siteUrl } from "@/lib/siteUrl";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-sans-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono-geist", display: "swap" });

export const metadata = {
  metadataBase: new URL(siteUrl()),
  title: "Solana RPC Benchmark",
  description: "Continuous, regional, non-gameable RPC benchmark",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// Web Analytics endpoint override. The app runs under basePath `/benchmarks`
// behind the helius.dev reverse proxy, which only forwards `/benchmarks/*`.
// Vercel serves the analytics script + beacon at the deployment ROOT
// (`/_vercel/insights/*`), so the default root-relative request resolves to
// `helius.dev/_vercel/insights/*` — never forwarded → 404, no events.
//
// A cross-origin override (pointing straight at *.vercel.app) doesn't work
// either: the beacon is a `fetch` POST with `Content-Type: application/json`,
// which is CORS-preflighted, and the insights collector returns no
// `Access-Control-Allow-Origin`, so the browser blocks it.
//
// So route BOTH through the SAME-ORIGIN, proxy-forwarded `/benchmarks/_vercel/
// insights/*` path (no CORS, first-party → fewer ad-blocker hits). next.config's
// external rewrite maps that path to the root collector server-side. Only set on
// Vercel — locally there's no collector, so leave the package defaults.
//
// `endpoint` alone is NOT enough, and its absence was silently costing every
// pageview: Vercel injects a build-time client config
// (REACT_APP_VERCEL_OBSERVABILITY_CLIENT_CONFIG) carrying per-project OBFUSCATED
// collector paths — viewEndpoint/eventEndpoint/sessionEndpoint like
// `/ad2fbf5bf24a631b/view`, randomized to dodge ad blockers. loadProps() merges
// that config UNDERNEATH our explicit props, so those three keys survive, and
// the collector script prefers a `<type>Endpoint` over the generic `endpoint`.
// Net effect: the beacon POSTed to `https://www.helius.dev/ad2fbf5bf24a631b/view`
// — a root path the proxy doesn't forward → 404 → zero recorded pageviews from
// the day the /benchmarks proxy went live (verified in-browser: script.js loads
// 200, `window.vai` set, then a 404 on the view beacon). So override all three
// explicitly; the generic `endpoint` still covers identify/group.
const analyticsProps = process.env.VERCEL
  ? {
      scriptSrc: "/benchmarks/_vercel/insights/script.js",
      viewEndpoint: "/benchmarks/_vercel/insights/view",
      eventEndpoint: "/benchmarks/_vercel/insights/event",
      sessionEndpoint: "/benchmarks/_vercel/insights/session",
      endpoint: "/benchmarks/_vercel/insights",
    }
  : {};

// Shared HTML shell only: fonts, global stylesheet, analytics, metadata. The
// site chrome (header nav + centered <main>) lives in the (site) route group's
// layout so the (embed) route group can render chromeless widgets under the
// same root. Route-group parens don't change URLs.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        {children}
        <Analytics {...analyticsProps} />
      </body>
    </html>
  );
}
