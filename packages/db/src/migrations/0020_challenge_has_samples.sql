-- Denormalize sample-presence onto challenges so the stale-expiry job stops
-- scanning the ~40M-row partitioned `samples` table every minute.
--
-- Background: expireStaleChallenges relabels `ready` past-TTL challenges that
-- got no samples as `expired` (cosmetic — keeps the dashboard's `ready` count
-- honest). It used `NOT EXISTS (SELECT FROM samples WHERE challenge_id = …)`,
-- which — against a ~1.5M-row `ready` backlog (mostly successful, sampled
-- challenges that never leave `ready`) — planned as a seq-scan of all 33
-- `samples` partitions every 60s and saturated Neon.
--
-- Fix: `has_samples` is set true when the first sample is written (insertSamples),
-- so expiry becomes `… AND has_samples = false` — a cheap challenges-only scan,
-- index-backed by the partial index below.
--
-- Additive + safe. The partial index is built over the current candidate set
-- (`ready` AND not-yet-flagged); a plain CREATE INDEX briefly SHARE-locks
-- challenge writes during the build (~1.5M rows, seconds) — matches the repo's
-- existing index-migration convention.

ALTER TABLE challenges
  ADD COLUMN IF NOT EXISTS has_samples boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS challenges_expiry_candidates_idx
  ON challenges (expires_at)
  WHERE status = 'ready' AND has_samples = false;
