import { ContainerImage, Secret as EcsSecret } from "aws-cdk-lib/aws-ecs";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import type { Secret } from "aws-cdk-lib/aws-secretsmanager";

/** Map secret keys to ECS secret references for a task definition's `secrets`. */
export function secretEnv(s: Secret, keys: readonly string[]): Record<string, EcsSecret> {
  const out: Record<string, EcsSecret> = {};
  for (const k of keys) out[k] = EcsSecret.fromSecretsManager(s, k);
  return out;
}

/** Neon connection strings — every service that talks to the DB binds these. */
export const NEON_SECRET_KEYS = [
  "NEON_DATABASE_URL_POOLED",
  "NEON_DATABASE_URL_DIRECT",
] as const;

/**
 * Benchmarked-panel provider URLs. Shared by the worker (which calls them) and
 * the generator (which does NOT call them, but needs them resolvable so
 * assertAuditorIndependent's host-overlap check has something to compare).
 * Removing any key silently disables the auditor-independence assertion for
 * that provider — keep this in one place so the two stacks can't drift.
 */
export const PANEL_SECRET_KEYS = [
  "HELIUS_API_KEY",
  "HELIUS_GATEKEEPER_URL",
  "TRITON_URL",
  "ALCHEMY_URL",
  "QUICKNODE_URL",
] as const;

/**
 * Build an x86_64 image from a Dockerfile at the repo root. Forcing
 * LINUX_AMD64 keeps Apple-Silicon builds from producing arm64 images that
 * crash on Fargate (x86_64) with "exec format error".
 */
export function linuxAmd64Image(dockerfile: string): ContainerImage {
  return ContainerImage.fromAsset("../../", { file: dockerfile, platform: Platform.LINUX_AMD64 });
}
