/**
 * CLI argument parsing for the standalone benchmark.
 *
 * Providers are supplied as repeatable `--provider name=url` (or in a
 * `--providers-file`). A URL may be given literally or as `env:VAR_NAME`, which
 * is resolved from the environment — so API keys never have to appear on the
 * command line (where the shell / pnpm would echo them into history + logs).
 *
 * The internal `provider_id` is a synthetic `byo-<index>` that is NEVER the
 * user's display name — see the ID-namespacing requirement: `buildSampleRows`
 * resolves `unsupported_methods`/panel state from the global roster by
 * `provider_id`, so a name like `quicknode` would silently collide.
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { EMITTED_METHODS, type Method } from "@rpcbench/shared";
import type { BenchProvider } from "./fanout.js";

// Emitted set + the two dormant methods kept CLI-testable, matching the
// operator benchmark's VALID_METHODS.
export const VALID_METHODS: Method[] = [
  ...EMITTED_METHODS,
  "getClusterNodes",
  "getLargestAccounts",
];

export interface CliConfig {
  providers: BenchProvider[];
  /** Explicit reference/auditor endpoint, or null (defaults to first provider). */
  referenceUrl: string | null;
  /** True when the user explicitly passed --reference/--auditor. */
  hasExplicitReference: boolean;
  challenges: number;
  methods: Method[];
  /** True when the user passed --methods explicitly (skips the interactive picker). */
  hasExplicitMethods: boolean;
  concurrency: number;
  json: boolean;
  /** Substring filter on bucket names (e.g. "archival"). */
  buckets: string | null;
  /** `--pick`: interactively choose methods before running (TTY only). */
  pick: boolean;
  /** `--seed <n>`: deterministic challenge selection (see index.ts). null = random. */
  seed: number | null;
  /** `--dump <path>`: write a per-challenge audit trail (JSON) to this file. */
  dump: string | null;
}

const USAGE = `rpcbench cli — standalone BYO-endpoint Solana RPC benchmark

Runs the production methodology locally against your own endpoints. No DB, no
cloud, no secret. Single vantage: latency is measured from THIS machine.

USAGE
  pnpm --filter cli start -- --provider <name>=<url> [--provider ...] [options]

PROVIDERS (repeatable, >=1 required)
  --provider <name>=<url>   An endpoint to benchmark. <name> is a display label.
                            <url> may be literal or env:VAR_NAME (resolved from
                            the environment — keeps API keys off the command line).
  --providers-file <path>   Read provider entries from a file: one "name=url" per
                            line, '#' comments and blank lines ignored. Merged with
                            any --provider flags.

CORRECTNESS
  --reference <url>         Score every endpoint against this trusted node instead
       (alias --auditor)    of panel consensus. Works with any endpoint count.
                            Without it: >=3 endpoints -> majority consensus,
                            1-2 -> correctness n/a (latency/reliability only).

SELECTION
  --methods <a,b,c>         Restrict to specific methods (default: all). Skips the
                            interactive picker.
  --pick                    Force the interactive arrow-key method picker (TTY).
                            (It also opens by default when --methods is omitted.)
  --buckets <substr>        Only run buckets whose name contains <substr>.

RUN
  --challenges <N>          How many challenges to run (default 30).
  --concurrency <N>         Challenges in flight at once (default 3).
  --seed <N>                Deterministic challenge selection for reproducible
                            runs (given the same chain tip). Default: random.

OUTPUT
  --json                    Emit machine-readable JSON instead of the live table.
  --dump <path>             Write a per-challenge audit trail (method, params,
                            per-endpoint result + hash, consensus decision) as
                            JSON to <path> — inspect exactly what was compared.
  -h, --help                Show this help.

EXAMPLES
  # keys via env, interactive method pick
  export HELIUS_URL=... TRITON_URL=...
  pnpm --filter cli start -- --provider helius=env:HELIUS_URL --provider triton=env:TRITON_URL

  # reproducible run of two methods, with an audit dump
  pnpm --filter cli start -- --providers-file providers.env \\
    --methods getBlock,getTransaction --seed 42 --dump run.json
`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

/** Resolve a provider URL: `env:VAR` -> process.env[VAR], else the literal URL. */
function resolveUrl(url: string, ctx: string): string {
  if (url.startsWith("env:")) {
    const name = url.slice(4).trim();
    if (!name) fail(`empty env var name in ${ctx}: ${url}`);
    const value = process.env[name];
    if (!value) fail(`env var ${name} is not set (referenced by ${ctx})`);
    return value.trim();
  }
  return url;
}

/** Parse one "name=url" entry into a synthetic-id BenchProvider. */
function parseEntry(entry: string, index: number, ctx: string): BenchProvider {
  const eq = entry.indexOf("=");
  if (eq <= 0) fail(`${ctx} must be name=url, got: ${entry}`);
  const name = entry.slice(0, eq).trim();
  const rawUrl = entry.slice(eq + 1).trim();
  if (!name) fail(`${ctx} name is empty in: ${entry}`);
  const url = resolveUrl(rawUrl, ctx);
  try {
    // Validate — protects the URL/Pool machinery downstream.
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    fail(`${ctx} url is not a valid URL: ${url.startsWith("http") ? url : rawUrl}`);
  }
  // Synthetic id — decoupled from `name` so it never collides with the roster.
  return { id: `byo-${index}`, name, url };
}

/** Read provider entries from a --providers-file (one name=url per line). */
function readProvidersFile(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    fail(`--providers-file not readable: ${path}`);
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

export function parseConfig(argv: string[]): CliConfig {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== "--"),
    options: {
      provider: { type: "string", multiple: true },
      "providers-file": { type: "string" },
      reference: { type: "string" },
      auditor: { type: "string" },
      challenges: { type: "string", default: "30" },
      methods: { type: "string" },
      concurrency: { type: "string", default: "3" },
      buckets: { type: "string" },
      json: { type: "boolean", default: false },
      pick: { type: "boolean", default: false },
      seed: { type: "string" },
      dump: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const rawEntries: string[] = [
    ...(values["providers-file"] ? readProvidersFile(values["providers-file"]) : []),
    ...(values.provider ?? []),
  ];
  if (rawEntries.length === 0) {
    fail(
      "at least one --provider name=url is required (or --providers-file <path>)\n" +
        "  example: --provider helius=env:HELIUS_URL --provider triton=https://...\n" +
        "  run with --help for full usage.",
    );
  }
  const providers: BenchProvider[] = rawEntries.map((entry, i) =>
    parseEntry(entry, i, "--provider"),
  );

  const challenges = Number.parseInt(values.challenges!, 10);
  if (!Number.isFinite(challenges) || challenges <= 0) {
    fail("--challenges must be a positive integer");
  }
  const concurrency = Number.parseInt(values.concurrency!, 10);
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    fail("--concurrency must be a positive integer");
  }

  let seed: number | null = null;
  if (values.seed != null) {
    seed = Number.parseInt(values.seed, 10);
    if (!Number.isFinite(seed)) fail("--seed must be an integer");
  }

  let methods: Method[];
  if (values.methods) {
    const parts = values.methods.split(",").map((s) => s.trim()) as Method[];
    for (const m of parts) {
      if (!VALID_METHODS.includes(m)) {
        fail(`unknown method: ${m}\n  valid: ${VALID_METHODS.join(",")}`);
      }
    }
    methods = parts;
  } else {
    methods = [...VALID_METHODS];
  }

  let buckets = values.buckets ?? null;
  if (buckets !== null) {
    buckets = buckets.trim();
  }

  // --reference wins; --auditor is an accepted alias.
  const referenceUrlRaw = values.reference ?? values.auditor ?? null;
  const referenceUrl = referenceUrlRaw !== null ? resolveUrl(referenceUrlRaw, "--reference") : null;
  if (referenceUrl !== null) {
    try {
      // eslint-disable-next-line no-new
      new URL(referenceUrl);
    } catch {
      fail(`--reference url is not a valid URL: ${referenceUrl}`);
    }
  }

  return {
    providers,
    referenceUrl,
    hasExplicitReference: referenceUrl !== null,
    challenges,
    methods,
    hasExplicitMethods: values.methods != null,
    concurrency,
    json: values.json === true,
    buckets,
    pick: values.pick === true,
    seed,
    dump: values.dump ?? null,
  };
}
