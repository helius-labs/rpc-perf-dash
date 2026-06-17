/**
 * Shared query-param parsing + validation for the read API routes
 * (app/api/*). Manual validation, no zod (the web app doesn't use it). Each
 * parser throws `ParamError` on bad input; routes catch it and return a 400
 * via `badRequest()`.
 */

import {
  GEO_REGIONS,
  WORKER_PROVIDER_LABELS,
  type ConnectionMode,
  type GeoRegion,
  type Method,
} from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOW_VALUES, WINDOWS } from "@/lib/windows";

/** Thrown by a parser when a param is present but invalid. */
export class ParamError extends Error {}

/** Standard 400 JSON response shape used across all read-API routes. */
export function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/** Trailing window in hours. Defaults to 24; must be a known WINDOWS value. */
export function parseWindow(raw: string | null): number {
  if (raw == null || raw === "") return 24;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || !WINDOW_VALUES.has(n)) {
    throw new ParamError(
      `invalid window '${raw}': expected one of ${WINDOWS.map((w) => w.value).join(", ")}`,
    );
  }
  return n;
}

/** Connection mode. Defaults to "cold". */
export function parseMode(raw: string | null): ConnectionMode {
  if (raw == null || raw === "") return "cold";
  if (raw !== "cold" && raw !== "warm") {
    throw new ParamError(`invalid mode '${raw}': expected 'cold' or 'warm'`);
  }
  return raw;
}

/** RPC method. Defaults to "getTransaction"; must be an ALL_METHODS value. */
export function parseMethod(raw: string | null): Method {
  if (raw == null || raw === "") return "getTransaction";
  if (!ALL_METHODS.includes(raw as Method)) {
    throw new ParamError(`invalid method '${raw}': see /api/meta for the method list`);
  }
  return raw as Method;
}

/**
 * Region selector. Defaults to "overall" (the cross-region blend); otherwise a
 * concrete GEO_REGIONS value.
 */
export function parseRegion(raw: string | null): GeoRegion | "overall" {
  if (raw == null || raw === "" || raw === "overall") return "overall";
  if (!(GEO_REGIONS as readonly string[]).includes(raw)) {
    throw new ParamError(
      `invalid region '${raw}': expected 'overall' or one of ${GEO_REGIONS.join(", ")}`,
    );
  }
  return raw as GeoRegion;
}

/**
 * Cloud-infra (worker_provider) selector. Undefined = pooled (`__all__`).
 * Validated against WORKER_PROVIDER_LABELS so any configured infra (incl.
 * hetzner / future additions) is accepted without a code edit here. Rejected
 * when `region` is "overall", since the blend is always pooled.
 */
export function parseInfra(
  raw: string | null,
  region: GeoRegion | "overall",
): string | undefined {
  if (raw == null || raw === "") return undefined;
  if (region === "overall") {
    throw new ParamError(
      "infra is only valid with a concrete region; the overall blend is always pooled",
    );
  }
  if (!Object.prototype.hasOwnProperty.call(WORKER_PROVIDER_LABELS, raw)) {
    throw new ParamError(
      `invalid infra '${raw}': expected one of ${Object.keys(WORKER_PROVIDER_LABELS).join(", ")}`,
    );
  }
  return raw;
}

/** Truthy flag parser ("1" / "true" → true; absent / anything else → false). */
export function parseBool(raw: string | null): boolean {
  return raw === "1" || raw === "true";
}

/**
 * Build a `${base}?${qs}` URL from the current page params plus overrides
 * (null in an override drops that key). Shared by the filter links on the
 * /performance and /challenges pages.
 */
export function buildPageUrl<P extends object>(
  base: string,
  params: P,
  override: Partial<Record<keyof P, string | null>>,
): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v != null) merged[k] = String(v);
  for (const [k, v] of Object.entries(override)) {
    if (v === null) delete merged[k];
    else if (v != null) merged[k] = String(v);
  }
  const qs = new URLSearchParams(merged).toString();
  return qs ? `${base}?${qs}` : base;
}
