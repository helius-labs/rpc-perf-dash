import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadEnv } from "../../packages/shared/src/env";

const here = dirname(fileURLToPath(import.meta.url));

// Single source of truth for the displayed app version: this app's package.json.
// Exposed as a NEXT_PUBLIC_ var so the header badge (and anywhere else) can read
// it without a second hardcoded string to keep in sync.
const appVersion = JSON.parse(
  readFileSync(join(here, "package.json"), "utf8"),
).version as string;

// Next only auto-loads apps/web/.env*, but this repo keeps local dev config in
// the repo-root .env/.env.local shared with the generator and worker. Load it
// here (config runs before any app code). Non-overwriting: platform-provided
// env (Vercel, CI) always wins over the files.
loadEnv(import.meta.url);

const config: NextConfig = {
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
  // The dashboard is served at https://www.helius.dev/benchmarks via a reverse
  // proxy (rewrite) on the helius.dev site — so the SEO authority accrues to
  // the apex domain instead of this app's *.vercel.app origin. basePath makes
  // Next prefix every internally-generated URL (assets, client nav, /api/*)
  // with /benchmarks so they all fall under the single proxied path; without
  // it the proxied app 404s on its own assets. assetPrefix defaults to
  // basePath, so _next/static is covered too. The raw origin now serves only
  // at rpc-perf-dash.vercel.app/benchmarks (root 404s — expected).
  basePath: "/benchmarks",
  reactStrictMode: true,
  typedRoutes: true,
  transpilePackages: ["@rpcbench/db", "@rpcbench/shared", "@rpcbench/methods"],
  experimental: {
    // Disable Next 15.5's dev-only "Segment Explorer" devtool. On the webpack
    // dev server it crashes after HMR with "Could not find the module
    // …/next-devtools/userspace/app/segment-explorer-node.js#SegmentViewNode in
    // the React Client Manifest" — its client module goes missing from the
    // incrementally-rebuilt RSC manifest, especially after adding/renaming
    // client components. It's a dev-overlay convenience only (no effect on the
    // app or the production build), so we turn it off to stop the crash spam.
    devtoolSegmentExplorer: false,
    // Pin the client Router Cache behavior. dynamic: 0 means navigating (incl.
    // back/forward) to a previously-visited dynamic URL refetches the RSC
    // instead of reusing a stale snapshot — so changing filters always shows
    // current data without the old blanket router.refresh() double-fetch. The
    // underlying server fetchers are unstable_cache'd for 30s, so "fresh" is
    // ≤30s old regardless. static: 180 lets fully-static routes (/methodology,
    // /changelog) reuse their cached payload for 3 min.
    staleTimes: { dynamic: 0, static: 180 },
  },
  // Allow the /embed/* widget routes to be framed on the helius.dev site (the
  // landing pages are same-origin under this basePath, so 'self' covers them;
  // the explicit helius.dev entries future-proof any subdomain host). Next
  // auto-prepends basePath to header `source`, so this matches /benchmarks/embed/*.
  // No X-Frame-Options — frame-ancestors supersedes it and expresses the allowlist.
  async headers() {
    return [
      {
        source: "/embed/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self' https://helius.dev https://*.helius.dev",
          },
        ],
      },
    ];
  },
  // Server-side hop for Web Analytics. The client (see layout.tsx) sends the
  // script + beacon to the SAME-ORIGIN `/benchmarks/_vercel/insights/*` path
  // (which the helius.dev proxy forwards, and which avoids the CORS wall on the
  // collector). Vercel actually serves those endpoints at the deployment ROOT
  // (`/_vercel/insights/*`), so rewrite there. Next forbids an INTERNAL rewrite
  // that leaves the basePath, but allows an absolute (external) destination — so
  // target the deployment's own production origin. `basePath: false` keeps the
  // source literal (matches the incoming proxied path as-is). No prod URL (local
  // dev) → no rewrite; analytics is a no-op there anyway.
  async rewrites() {
    const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (!prod) return [];
    return [
      {
        source: "/benchmarks/_vercel/insights/:path*",
        destination: `https://${prod}/_vercel/insights/:path*`,
        basePath: false,
      },
    ];
  },
  // Bundle the docs/*.md files into the serverless function output so the
  // methodology + changelog pages can read them at request time on Vercel.
  outputFileTracingRoot: join(here, "../.."),
  outputFileTracingIncludes: {
    "/methodology": ["../../docs/methodology.md"],
    "/changelog": ["../../docs/changelog.md"],
  },
  webpack(config) {
    // Workspace packages use NodeNext-style `.js` extensions in their TS imports
    // (so generator/worker/rollup-cron run natively on Node). Webpack needs to
    // resolve those `.js` paths to the `.ts` source files.
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default config;
