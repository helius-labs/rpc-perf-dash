/**
 * /sends — transaction-landing leaderboard. Mirrors the RPC Overview page: an
 * animated winner hero, workload preset chips + Customize + Share, and the same
 * "Index, dark" expandable ranked list. All the interactive board lives in the
 * client <SendsBoard>; this page just fetches the (default-weighted) rows.
 */

import type { Metadata } from "next";
import { fetchSendBoard } from "@/lib/sends";
import { SendsBoard } from "@/components/SendsBoard";
import { DB_ERROR_MESSAGE } from "@/lib/db";
import { pageSeo } from "@/lib/seo";

export const revalidate = 120;

// No searchParams on this route, so no params argument — it can't be turned
// into a duplicate URL. Static `metadata` (not generateMetadata) keeps the ISR
// render above intact.
export const metadata: Metadata = {
  title: "Transaction landing benchmark — Solana RPC Benchmark",
  description:
    "Which Solana RPC lands transactions fastest and most reliably: continuous, independent send benchmarks with landing rate and time-to-land.",
  ...pageSeo("/sends"),
};

export default async function SendsPage() {
  let rows;
  try {
    rows = await fetchSendBoard("1d");
  } catch (err) {
    console.error("[sends]", (err as Error).message);
    return <p className="mt-9 text-[14px] text-muted">{DB_ERROR_MESSAGE}</p>;
  }

  return <SendsBoard rows={rows} />;
}
