/**
 * /costs — RPC provider cost comparator.
 *
 * FEATURE-GATED behind NEXT_PUBLIC_FEATURE_COSTS (see lib/flags.ts): the route
 * 404s when the flag is off, and navItems.ts hides the tab, so this stays dark
 * in prod until we deliberately flip it.
 *
 * The page is a thin server shell: it gates, parses the basket from the URL
 * (shareable links), and hands off to the client island. The cost engine is
 * pure and client-safe, so all simulation + live editing happens client-side
 * with zero round-trips; the URL is the single source of shareable state.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isFeatureEnabled } from "@/lib/flags";
import { parseBasket } from "@/lib/pricing/basket";
import CostsExplorer from "./CostsExplorer";

export const metadata: Metadata = {
  title: "Costs — RPC provider comparator",
  description:
    "Simulate a basket of RPC calls and streaming usage and compare estimated monthly cost across providers, in native units and USD.",
  robots: { index: false, follow: false },
};

interface SearchParams {
  m?: string;
  stream?: string;
  plan?: string;
  preset?: string;
  calls?: string;
  peak?: string;
  bytes?: string;
}

export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (!isFeatureEnabled("costs")) notFound();
  const params = await searchParams;
  const basket = parseBasket(params);
  return <CostsExplorer initialBasket={basket} />;
}
