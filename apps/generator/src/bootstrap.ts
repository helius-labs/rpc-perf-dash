/**
 * One-command bootstrap for the full system (README "Option B").
 *
 * Automates the tedious parts of standing up the DB-backed benchmark:
 *   1. Preflight — check the required env vars are present (and warn on a
 *      too-small provider panel).
 *   2. Migrate — apply the schema.
 *   3. Seed honeypots — for all three honeypot-capable methods in one pass.
 *
 * It deliberately does NOT start the long-running processes (generator / worker
 * / web) — those belong in their own terminals or a supervisor — but it prints
 * the exact commands to run next.
 *
 *   pnpm bootstrap
 *   pnpm bootstrap --honeypot-count 500
 *   pnpm bootstrap --skip-seed
 *   pnpm bootstrap --skip-migrate --skip-seed   # preflight only
 *
 * (Named `bootstrap`, not `setup`, because `pnpm setup` is a pnpm built-in.)
 */

import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import {
  CONFIGURED_BENCHMARKED,
  MIN_CONSENSUS_VOTERS,
  UTILITY_PROVIDER,
  loadEnv,
  resolveEndpointUrl,
} from "@rpcbench/shared";

loadEnv(import.meta.url);

const OK = "✓"; // ✓
const NO = "✗"; // ✗
const WARN = "!";

interface CheckResult {
  ok: boolean;
  required: boolean;
  label: string;
  detail: string;
}

function preflight(): { results: CheckResult[]; fatal: boolean } {
  const results: CheckResult[] = [];

  const dbDirect =
    process.env.NEON_DATABASE_URL_DIRECT ?? process.env.DATABASE_URL_UNPOOLED;
  results.push({
    ok: !!dbDirect,
    required: true,
    label: "Postgres (direct)",
    detail: dbDirect ? "NEON_DATABASE_URL_DIRECT set" : "set NEON_DATABASE_URL_DIRECT in .env.local",
  });

  const dbPooled = process.env.NEON_DATABASE_URL_POOLED ?? process.env.DATABASE_URL;
  results.push({
    ok: !!dbPooled,
    required: false,
    label: "Postgres (pooled)",
    detail: dbPooled
      ? "NEON_DATABASE_URL_POOLED set"
      : "NEON_DATABASE_URL_POOLED unset — workers need it; locally it can equal the direct URL",
  });

  const secret = process.env.GENERATOR_SECRET;
  results.push({
    ok: !!secret,
    required: true,
    label: "Commit-reveal secret",
    detail: secret ? "GENERATOR_SECRET set" : "set GENERATOR_SECRET (openssl rand -hex 32)",
  });

  const utilityUrl = UTILITY_PROVIDER ? resolveEndpointUrl(UTILITY_PROVIDER.endpoints[0]!) : null;
  results.push({
    ok: !!utilityUrl,
    required: true,
    label: "Utility RPC (derivation + honeypot ground truth)",
    detail: utilityUrl ? "UTILITY_RPC_URL set" : "set UTILITY_RPC_URL in .env.local",
  });

  const configured = CONFIGURED_BENCHMARKED();
  const names = configured.map((p) => p.name).join(", ");
  results.push({
    ok: configured.length >= 1,
    required: true,
    label: "Benchmarked providers",
    detail:
      configured.length === 0
        ? "no provider endpoints set (HELIUS_URL / TRITON_URL / ALCHEMY_URL / QUICKNODE_URL / …)"
        : configured.length < MIN_CONSENSUS_VOTERS
          ? `${configured.length} configured (${names}) — need ≥${MIN_CONSENSUS_VOTERS} for correctness/consensus; latency still works`
          : `${configured.length} configured (${names})`,
  });

  const fatal = results.some((r) => r.required && !r.ok);
  return { results, fatal };
}

function printChecklist(results: CheckResult[]): void {
  console.log("\nPreflight");
  console.log("=".repeat(60));
  for (const r of results) {
    const mark = r.ok ? OK : r.required ? NO : WARN;
    console.log(`  ${mark}  ${r.label}`);
    console.log(`       ${r.detail}`);
  }
  console.log("");
}

function run(cmd: string): void {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      "honeypot-count": { type: "string", default: "100" },
      "skip-migrate": { type: "boolean", default: false },
      "skip-seed": { type: "boolean", default: false },
    },
  });

  const honeypotCount = Number.parseInt(values["honeypot-count"]!, 10);
  if (!Number.isFinite(honeypotCount) || honeypotCount <= 0) {
    console.error("--honeypot-count must be a positive integer");
    process.exit(2);
  }

  console.log("RPC Benchmark — full-system setup (Option B)");

  const { results, fatal } = preflight();
  printChecklist(results);
  if (fatal) {
    console.error(
      "Preflight failed: fill in the required (✗) values in .env.local, then re-run `pnpm bootstrap`.\n" +
        "See the README “Option B” section for what each variable is.",
    );
    process.exit(1);
  }

  if (!values["skip-migrate"]) {
    run("pnpm --filter @rpcbench/db migrate");
  } else {
    console.log("\n(skipping migrations: --skip-migrate)");
  }

  if (!values["skip-seed"]) {
    run(`pnpm --filter generator seed-honeypots --method all --count ${honeypotCount}`);
  } else {
    console.log("(skipping honeypot seeding: --skip-seed)");
  }

  console.log("\n" + "=".repeat(60));
  console.log("Setup complete. Start the system (each in its own terminal):");
  console.log("");
  console.log("  pnpm dev:generator    # produces challenges every 30s");
  console.log("  pnpm dev:worker       # fires calls at providers");
  console.log("  pnpm dev:web          # dashboard at http://localhost:3000");
  console.log("");
  console.log("Or a single one-shot run:  pnpm benchmark");
  console.log("=".repeat(60));

  process.exit(0);
}

main();
