import { ContainerImage, Secret as EcsSecret } from "aws-cdk-lib/aws-ecs";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import type { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { PANEL_ENV_KEYS } from "@rpcbench/shared/env-keys";

/** Map secret keys to ECS secret references for a task definition's `secrets`. */
export function secretEnv(s: Secret, keys: readonly string[]): Record<string, EcsSecret> {
  const out: Record<string, EcsSecret> = {};
  for (const k of keys) out[k] = EcsSecret.fromSecretsManager(s, k);
  return out;
}

/**
 * Neon connection strings. The DIRECT (unpooled) URL is only needed by services
 * that run DDL or long transactions — the generator and migrations. Workers open
 * a pooled connection only (createDb({ mode: "pooled" })), so they must NOT
 * receive the direct URL.
 */
export const NEON_SECRET_KEYS = [
  "NEON_DATABASE_URL_POOLED",
  "NEON_DATABASE_URL_DIRECT",
] as const;

/** DB secrets for workers: pooled only (workers never open a direct connection). */
export const NEON_WORKER_SECRET_KEYS = ["NEON_DATABASE_URL_POOLED"] as const;

/**
 * Benchmarked-panel provider URLs, bound on the worker task (workers call the
 * panel). Sourced directly from the provider registry via `PANEL_ENV_KEYS`
 * (packages/shared/src/env-keys.ts) so the worker stack can never drift from
 * the set of benchmarked providers.
 */
export const PANEL_SECRET_KEYS = PANEL_ENV_KEYS;

/**
 * Build an x86_64 image from a Dockerfile at the repo root. Forcing
 * LINUX_AMD64 keeps Apple-Silicon builds from producing arm64 images that
 * crash on Fargate (x86_64) with "exec format error".
 */
export function linuxAmd64Image(dockerfile: string): ContainerImage {
  return ContainerImage.fromAsset("../../", { file: dockerfile, platform: Platform.LINUX_AMD64 });
}
