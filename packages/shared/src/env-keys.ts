/**
 * Single source of truth for the env-var KEY SETS that fan out across the
 * deploy paths.
 *
 * The worker-secret list used to be hand-copied into ~7 places (the docs
 * rebuild snippet, seed-secrets.sh, terraform locals, the CF Worker proxy
 * ×2, the CDK util list). A provider add/rename that missed one silently
 * produced a cloud with zero samples for that provider. Everything that needs
 * "which keys do workers get" / "which keys live in the AWS blob" now derives
 * from here: TS consumers import these constants; non-importable consumers
 * (terraform HCL, the seed-secrets.sh filter, the CDK secret template) keep
 * literal lists that `env-keys.test.ts` asserts against these — so CI fails on
 * drift instead of a cloud going quietly sample-less.
 *
 * Import via the `@rpcbench/shared/env-keys` subpath (not the package barrel)
 * from bundled targets like the CF Worker, so `env.ts` (node:fs) isn't dragged
 * into their bundle.
 */

import { BENCHMARKED_PROVIDERS } from "./providers.js";

/**
 * Env-var names backing the benchmarked panel endpoints, derived from the
 * provider registry. A provider may declare multiple equivalent `env:`
 * endpoints, so dedupe. Mirrors the `env:`-prefix convention resolved by
 * `resolveEndpointUrl` in providers.ts.
 */
export const PANEL_ENV_KEYS: readonly string[] = Array.from(
  new Set(
    BENCHMARKED_PROVIDERS.flatMap((p) => p.endpoints)
      .map((ep) => (ep.url.startsWith("env:") ? ep.url.slice(4) : null))
      .filter((k): k is string => k !== null),
  ),
);

/**
 * Secrets bound on every worker fleet (AWS / GCP / CF / TSW): the pooled Neon
 * URL plus the panel provider URLs. Workers open a pooled connection only, so
 * the DIRECT URL is deliberately excluded; `GENERATOR_SECRET` and
 * `UTILITY_RPC_URL` are generator-only and never bound on workers.
 */
export const WORKER_SECRET_KEYS: readonly string[] = [
  "NEON_DATABASE_URL_POOLED",
  ...PANEL_ENV_KEYS,
];

/**
 * The full key set stored in the canonical AWS Secrets Manager blob
 * (`rpcbench/env`): the worker secrets plus the generator-only keys (direct DB
 * URL, utility endpoint, commit-reveal secret). Used by the reverse
 * `.env -> AWS` seed (`seed-aws.ts`) and asserted against the CDK secret
 * template (`secretStringTemplate` keys ∪ `generateStringKey`).
 */
export const AWS_ENV_KEYS: readonly string[] = [
  ...WORKER_SECRET_KEYS,
  "NEON_DATABASE_URL_DIRECT",
  "UTILITY_RPC_URL",
  "GENERATOR_SECRET",
];
