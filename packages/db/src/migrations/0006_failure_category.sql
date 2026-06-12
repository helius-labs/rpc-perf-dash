-- 0006_failure_category.sql
--
-- Finer-grained failure classification on each sample. The existing
-- correctness/exclusion_reason columns are kept; these two add detail.
--
-- failure_category is NULL when the sample is correct.
-- failure_detail provides additional context (e.g. specific RPC error code
-- or a provider-specific marker like 'alchemy_monthly_capacity_exceeded').

ALTER TABLE samples ADD COLUMN IF NOT EXISTS failure_category text;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS failure_detail   text;

-- Index for the per-provider failure breakdown panel on /provider/[id].
-- Partial index excludes the common case (correct samples).
CREATE INDEX IF NOT EXISTS samples_failure_category_idx
  ON samples (provider_id, failure_category, started_at DESC)
  WHERE failure_category IS NOT NULL;
