/**
 * Canonical absolute origin for the deployment, used for OG/Twitter card
 * `metadataBase` and for resolving the share-image URL absolutely (social
 * scrapers can't follow relative image paths).
 *
 * Resolution order: an explicit NEXT_PUBLIC_SITE_URL (set in prod), then
 * Vercel's auto-injected VERCEL_URL, then localhost for dev.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/** Bare host for display (e.g. the share-card footer). */
export function siteDisplayHost(): string {
  try {
    return new URL(siteUrl()).host;
  } catch {
    return "solana-rpc-benchmark";
  }
}
