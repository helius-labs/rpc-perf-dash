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
const analyticsProps = process.env.VERCEL
  ? {
      scriptSrc: "/benchmarks/_vercel/insights/script.js",
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
