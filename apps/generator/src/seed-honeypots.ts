/**
 * One-shot CLI: seed the honeypot pool by sampling deeply-finalized history.
 *
 * Ground truth comes from the utility endpoint directly: honeypot seeding trusts
 * its archival fetch. Operator should spot-check the resulting honeypot rows
 * before enabling injection in production.
 *
 * Run with:
 *   pnpm --filter generator seed-honeypots --method getBlock --count 100
 *   pnpm --filter generator seed-honeypots --method all --count 100   # all 3
 *
 * Only three methods are honeypot-capable (a stable historical answer to
 * replay): getBlock, getTransaction, getSignaturesForAddress. `--method all`
 * seeds every one of them in a single invocation. Methodology target is ~2000
 * per method.
 */

import { parseArgs } from "node:util";
import { createDb } from "@rpcbench/db";
import {
  METHODOLOGY_VERSION,
  UTILITY_PROVIDER,
  loadEnv,
  resolveEndpointUrl,
  type Method,
} from "@rpcbench/shared";
import { createRpcClient } from "./rpc.js";
import { seedHoneypotPool } from "./honeypot.js";

loadEnv(import.meta.url);

const VALID_METHODS: Method[] = ["getBlock", "getTransaction", "getSignaturesForAddress"];

async function main() {
  const { values } = parseArgs({
    options: {
      method: { type: "string" },
      count: { type: "string", default: "100" },
    },
  });

  // `all` fans out across every honeypot-capable method.
  const isAll = values.method === "all";
  if (!isAll && (!values.method || !VALID_METHODS.includes(values.method as Method))) {
    console.error(`Usage: --method <all|${VALID_METHODS.join("|")}> --count <N>`);
    process.exit(2);
  }
  const methods: Method[] = isAll ? VALID_METHODS : [values.method as Method];
  const toAdd = parseInt(values.count!, 10);
  if (!Number.isFinite(toAdd) || toAdd <= 0) {
    console.error("--count must be a positive integer");
    process.exit(2);
  }

  // Build clients.
  const db = createDb({ mode: "direct" });

  if (!UTILITY_PROVIDER) {
    console.error("UTILITY_PROVIDER missing");
    process.exit(2);
  }
  const utilityUrl = resolveEndpointUrl(UTILITY_PROVIDER.endpoints[0]!);
  if (!utilityUrl) {
    console.error("UTILITY_RPC_URL not set");
    process.exit(2);
  }
  const utility = createRpcClient(utilityUrl, 10_000);

  // Get current tip via utility.
  const tipSlot = BigInt(await utility.call<number>("getSlot", [{ commitment: "finalized" }]));
  console.log(
    `[seed-honeypots] tip slot ${tipSlot}, adding up to ${toAdd} honeypots each for: ${methods.join(", ")}`,
  );

  for (const method of methods) {
    const t0 = Date.now();
    const added = await seedHoneypotPool({
      db,
      method,
      tipSlot,
      utility,
      methodologyVersion: METHODOLOGY_VERSION,
      toAdd,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[seed-honeypots] added ${added}/${toAdd} ${method} honeypots in ${elapsed}s`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[seed-honeypots] fatal", err);
  process.exit(1);
});
