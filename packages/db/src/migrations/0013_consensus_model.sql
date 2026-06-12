-- 0013_consensus_model.sql
--
-- Methodology version 1 → 2. Replaces the rotating neutral quorum with
-- majority consensus across the benchmarked panel + an independent
-- auditor cross-check. See docs/methodology.md.
--
-- This migration is data-only on the existing tables (providers + a couple of
-- column-set tweaks); the new structural state lives in two new tables:
--   - consensus_log (per challenge × vantage × mode)
--   - consensus_audit (deferred finality re-verification)
-- The legacy quorum_log and quorum_membership tables are preserved as-is so
-- /raw can still render pre-cutover history.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- Provider registry — drop the 5 quorum-only nodes; flip flux to benchmarked.
-- ──────────────────────────────────────────────────────────────────────
-- eligibility rows reference providers.id; remove first so the DELETE doesn't
-- collide with the FK. (Quorum-only providers never produced eligibility rows
-- in practice, but be defensive.)
DELETE FROM eligibility
WHERE provider_id IN
  ('solana_foundation_public', 'chainstack', 'ankr', 'drpc', 'blockdaemon');

DELETE FROM providers
WHERE id IN
  ('solana_foundation_public', 'chainstack', 'ankr', 'drpc', 'blockdaemon');

UPDATE providers SET benchmarked = true WHERE id = 'flux';

-- Drop the now-unused column. Seed-providers.ts no longer writes it.
ALTER TABLE providers DROP COLUMN IF EXISTS quorum_eligible;

-- ──────────────────────────────────────────────────────────────────────
-- Bury any leftover v=1 control-plane states. methodology_version=2 challenges
-- are created in the 'ready' status directly; the 'pending_quorum' and
-- challenge-level 'ambiguous' phases are gone.
-- ──────────────────────────────────────────────────────────────────────
UPDATE challenges
SET status = 'expired'
WHERE status IN ('pending_quorum', 'ambiguous')
  AND methodology_version < 2;

-- ──────────────────────────────────────────────────────────────────────
-- New: consensus_log (per challenge × vantage × mode).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consensus_log (
  challenge_id      uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  worker_provider   text NOT NULL,
  region            text NOT NULL,
  egress_path       text NOT NULL,
  connection_mode   text NOT NULL,
  voters            jsonb NOT NULL,        -- [{id, projection_hash, in_majority}]
  decision          text NOT NULL,         -- 'consensus' | 'ambiguous'
  decision_reason   text,
  dissenters        jsonb,                 -- string[] of provider ids
  auditor_verdict   text NOT NULL,         -- 'verified' | 'disputed' | 'auditor_unavailable'
  decided_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, worker_provider, region, egress_path, connection_mode)
);
CREATE INDEX IF NOT EXISTS consensus_log_decided_idx ON consensus_log (decided_at);
CREATE INDEX IF NOT EXISTS consensus_log_verdict_idx ON consensus_log (auditor_verdict, decided_at);

-- ──────────────────────────────────────────────────────────────────────
-- New: consensus_audit (deferred finality re-verification).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consensus_audit (
  challenge_id     uuid PRIMARY KEY REFERENCES challenges(id) ON DELETE CASCADE,
  method           text NOT NULL,
  audited_at       timestamptz NOT NULL DEFAULT now(),
  consensus_hash   bytea NOT NULL,
  canonical_hash   bytea,
  matched          boolean,
  error            text
);
CREATE INDEX IF NOT EXISTS consensus_audit_audited_idx
  ON consensus_audit (method, audited_at);

-- Methodology versioning row for the public audit page.
INSERT INTO methodology_versions (version, effective_from, changelog)
VALUES (
  2,
  now(),
  'Replaced the rotating neutral quorum (SF Public / Flux / Chainstack / Ankr / dRPC / Blockdaemon) with majority consensus across the benchmarked panel (Helius, Triton, Alchemy, QuickNode, Flux). Flux promoted to a benchmarked provider; SF Public, Chainstack, Ankr, dRPC, Blockdaemon removed. Added an independent auditor cross-check (utility endpoint) and a periodic finality re-verification job. getProgramAccounts and getTokenAccountsByOwner re-enabled for correctness scoring.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
