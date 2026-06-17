/**
 * Idempotent upsert of every entry from `providers.ts` into the providers
 * table. Called once at generator boot.
 *
 * The `providers` table is referenced by `eligibility.provider_id` (FK), so
 * if it's empty the rollup-cron's eligibility UPSERT crashes. The runtime
 * code (generator + worker fan-out) reads from the in-memory PROVIDERS
 * constant — so the table is purely there to satisfy the FK.
 *
 * The `quorum_eligible` column was dropped in migration 0013, so it is not
 * written here.
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "@rpcbench/db";
import { PROVIDERS } from "@rpcbench/shared";

export async function ensureProvidersSeeded(db: DbClient): Promise<void> {
  for (const p of PROVIDERS) {
    const config = {
      endpoints: p.endpoints,
      data_centers: p.data_centers,
      pricing: p.pricing,
      anti_gaming_flags: p.anti_gaming_flags,
      notes: p.notes ?? null,
    };
    await db.execute(sql`
      INSERT INTO providers (
        id, name, benchmarked, utility,
        tier_name, retention_slots, monthly_cap, config
      ) VALUES (
        ${p.id}, ${p.name}, ${p.benchmarked}, ${p.utility},
        ${p.tier_name},
        ${typeof p.retention_slots === "number" ? p.retention_slots.toString() : p.retention_slots},
        ${p.monthly_cap},
        ${JSON.stringify(config)}::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        name             = EXCLUDED.name,
        benchmarked      = EXCLUDED.benchmarked,
        utility          = EXCLUDED.utility,
        tier_name        = EXCLUDED.tier_name,
        retention_slots  = EXCLUDED.retention_slots,
        monthly_cap      = EXCLUDED.monthly_cap,
        config           = EXCLUDED.config
    `);
  }
}
