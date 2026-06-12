import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
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
