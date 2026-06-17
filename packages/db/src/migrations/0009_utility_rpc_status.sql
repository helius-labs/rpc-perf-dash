-- 0009_utility_rpc_status.sql
--
-- Per-endpoint health snapshot for the generator's utility-RPC client.
-- Written by the generator every ~10s; consumed by the dashboard's
-- ProviderHealth "Utility RPC" row. See packages/db/src/schema.ts for the
-- column-level commentary.
--
-- Motivation: a single utility-RPC provider returning HTTP 403 can freeze the
-- generator's slot polling silently, with nothing surfacing the failing
-- endpoint. This table is the visibility hook; the multi-endpoint client
-- (apps/generator/src/utility-client.ts) is the fail-over mechanism.

CREATE TABLE IF NOT EXISTS utility_rpc_status (
  endpoint_index integer PRIMARY KEY,
  url_label      text NOT NULL,
  last_ok_at     timestamptz,
  last_err_at    timestamptz,
  last_err_msg   text,
  consec_fails   integer NOT NULL DEFAULT 0,
  circuit_state  text NOT NULL DEFAULT 'closed'
                 CHECK (circuit_state IN ('closed', 'open', 'half-open')),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
