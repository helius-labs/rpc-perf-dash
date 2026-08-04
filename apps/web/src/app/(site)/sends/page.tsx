/**
 * /sends — transaction-landing leaderboard. Mirrors the RPC Overview page: an
 * animated winner hero, workload preset chips + Customize + Share, and the same
 * "Index, dark" expandable ranked list. All the interactive board lives in the
 * client <SendsBoard>; this page just fetches the (default-weighted) rows.
 */

import { fetchSendBoard } from "@/lib/sends";
import { SendsBoard } from "@/components/SendsBoard";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export const revalidate = 120;

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
