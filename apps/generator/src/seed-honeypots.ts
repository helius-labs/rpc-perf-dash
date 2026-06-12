/**
 * One-shot CLI: seed the honeypot pool by sampling deeply-finalized history.
 *
 * Methodology_version 2: ground truth comes from the AUDITOR (utility)
 * endpoint directly. The rotating quorum is gone, so honeypot seeding now
 * trusts the auditor's archival fetch. Operator should spot-check the
 * resulting honeypot rows before flipping injection on in production.
 *
 * Run with:
 *   pnpm --filter generator seed-honeypots --method getBlock --count 100
 *
 * Repeat per method. Methodology target is ~2000 per method.
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

  if (!values.method || !VALID_METHODS.includes(values.method as Method)) {
    console.error(`Usage: --method <${VALID_METHODS.join("|")}> --count <N>`);
    process.exit(2);
  }
  const method = values.method as Method;
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
  console.log(`[seed-honeypots] tip slot ${tipSlot}, attempting to add ${toAdd} ${method} honeypots via auditor`);

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

  process.exit(0);
}

main().catch((err) => {
  console.error("[seed-honeypots] fatal", err);
  process.exit(1);
});
