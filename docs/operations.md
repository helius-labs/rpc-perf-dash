# Operations runbook

Things to know before deploying or changing infrastructure: deploy ordering,
the env-var fan-out, per-cloud gotchas, and recovery procedures. Read it
end-to-end before touching `infra/`, `packages/shared/src/providers.ts`, or any
secrets.

---

## Deploy order — strict

Methodology bumps and schema changes require this order. Skipping a step causes
the obvious downstream failure.

1. **DB migrations** (`pnpm db:migrate`) — generator + workers expect the new
   schema. Migration must be idempotent (use `IF NOT EXISTS`, `ON CONFLICT`,
   `IF EXISTS` on drops).
2. **Generator** (`cdk deploy RpcBenchGenerator --exclusively`) — writes the
   new challenge shape. Must redeploy BEFORE workers: a worker running old code
   against the new schema would error, and a new-code worker reading old-shape
   challenges would misclassify.
3. **Workers** — all four deploy paths. AWS / TSW / CF / GCP (any order between
   themselves; they're independent). `bash infra/scripts/deploy-all-workers.sh`
   covers all four serially.
4. **Web app** (Vercel) — read-only against the DB. Deploys whenever; can be
   skipped during ops emergencies and rolled later for UI updates.

For provider-config changes (adding / removing / re-tiering a provider): same
order, but you also have to wire env vars through every worker deploy path
*before* step 3 — see the matrix below.

---

## Env var propagation matrix

A new provider's URL has to land in NINE places before workers can query it.
This is the most error-prone part of the system — the CF Worker→Container proxy
(row 8) is the easiest to miss.

| # | Location | Purpose | What to edit |
|---|---|---|---|
| 1 | `packages/shared/src/providers.ts` | Provider registry + endpoint spec | Add a `ProviderRow` with `endpoints: [{url: "env:NEW_PROVIDER_URL"}]`. |
| 2 | `infra/cdk/lib/secrets-stack.ts` | AWS Secrets Manager *initial* template | Add the key to the `generateSecretString` JSON. Only seeds **brand-new** secrets — existing secrets need manual `put-secret-value`. |
| 3 | AWS Secrets Manager `rpcbench/env` value | The real secret value | `aws secretsmanager put-secret-value --secret-id rpcbench/env ...` — pull current JSON, add the key, push back. |
| 4 | `infra/cdk/lib/generator-stack.ts` | Generator container env-var binding | `secretEnv(props.secret, [...])` — must include the new key so `assertAuditorIndependent()` and `resolveEndpointUrl()` see it. |
| 5 | `infra/cdk/lib/worker-stack.ts` | AWS worker container env-var binding | Same `secretEnv` list as above. |
| 6 | `infra/gcp/terraform/main.tf` | GCP `local.secret_keys` | Terraform creates the Secret Manager secret resource + worker IAM binding for each key. |
| 7 | `infra/gcp/seed-secrets.sh` | `WORKER_SECRETS` array | Filter list — keys NOT here get skipped when pushing values into Secret Manager. **Keep in sync with the terraform list.** |
| 8 | `infra/cloudflare/src/index.ts` | CF Worker → Container env-var proxy | The `Env` interface AND the `this.envVars = { ... }` block. **CF secrets do NOT auto-propagate to the container** — every key has to be listed manually. |
| 9 | `/tmp/rpc-bench-worker.env.shared` (operator local) | Source of values for TSW + CF deploys | Rebuild from AWS Secrets Manager: see "Rebuilding the shared env file" below. |

**Verifier:** after a provider rollout, query
```sql
SELECT worker_provider, count(*) FROM samples
WHERE provider_id = '<new_provider>' AND started_at > now() - interval '2 min'
GROUP BY 1;
```
A cloud missing from the result means its deploy path didn't get the env var.

### Rebuilding the shared env file

```bash
aws secretsmanager get-secret-value --secret-id rpcbench/env \
  --region us-east-2 --profile "$AWS_PROFILE" --query SecretString --output text \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
WANT = ["NEON_DATABASE_URL_POOLED","NEON_DATABASE_URL_DIRECT",
        "HELIUS_API_KEY","HELIUS_GATEKEEPER_URL","TRITON_URL",
        "ALCHEMY_URL","QUICKNODE_URL"]
for k in WANT:
    v = d.get(k, "")
    if v: print(f"{k}={v}")
' > /tmp/rpc-bench-worker.env.shared
```

---

## Per-cloud deploy gotchas

### AWS (CDK / ECS Fargate)
- **Secrets binding is in the task def.** Adding a key to `secretEnv()` requires a `cdk deploy` of the worker stack (rev bumps task def). Manual `put-secret-value` alone isn't enough — the container won't see the new key until the task def references it.
- **`cdk deploy` is idempotent on workspace state.** It builds the docker image from the working tree (uncommitted changes included).
- **Asset publish flakes happen.** "Failed to publish asset" between regions is usually transient — retry just the failed region.
- Region order: serial. Deploy us-east-2 first (home region) so the generator is on the new code before workers ramp.

### GCP (Cloud Run + Terraform + Artifact Registry)
- **Cloud Run won't recycle on unchanged image tag.** `build-image.sh` tags with `git rev-parse --short HEAD`. With uncommitted changes, the SHA doesn't move → docker pushes new layers under the same tag → terraform's `worker_image` var unchanged → no new revision → containers keep serving old code.
  - **Workaround:** `URI=$(bash infra/gcp/build-image.sh "$(date +%s)")` to force a unique tag.
- **First-time secret addition is two-phase.** Terraform creates the `google_secret_manager_secret` resource (empty, no version); the Cloud Run service then refuses to start because `secret/versions/latest` doesn't exist. Order:
  1. Terraform apply to create the secret resource (Cloud Run revision will fail to start — expected).
  2. `seed-secrets.sh` to add a version.
  3. Terraform apply again with a fresh image tag to roll Cloud Run.
- **Auth:** `gcloud auth print-access-token` exports `GOOGLE_OAUTH_ACCESS_TOKEN` for the terraform google provider. (Useful when Application Default Credentials are blocked by org policy on the project.)

### Cloudflare (Workers + Containers)
- **Auth: run `wrangler login` first (Containers scope required).** `deploy-cf.sh`'s
  `wrangler containers push` 403s with `"cloudchamber push failed"` if the session
  is stale or the API token lacks **Containers:Edit**. See the auth-prerequisites
  block under "Quick reference" for the full fix.
- **`wrangler deploy` direct doesn't build the image.** `wrangler.jsonc` has `__IMAGE_TAG__` as a placeholder — running raw `wrangler deploy` pushes a config referencing a non-existent image. **Always use `deploy-cf.sh`** which builds + pushes + substitutes the tag + deploys.
- **Same "no changes on unchanged tag" problem as GCP.** `deploy-cf.sh` tags with git SHA. With uncommitted changes, wrangler sees the same container config and prints "no changes" — secrets get updated but running container instances are not recycled with the new env.
  - **Workaround:** `TAG="cf-$(date +%s)" bash infra/cloudflare/deploy-cf.sh`. The script honors a `TAG` env override.
- **CRITICAL: Worker secrets do NOT auto-propagate to the container.** The Worker (`infra/cloudflare/src/index.ts`) has to manually list each secret in two places:
  1. The `Env` TypeScript interface.
  2. The `WorkerContainer` constructor's `this.envVars = { ... }` block.
  Missing a key here → container boots without that env var → `resolveEndpointUrl` returns null → `isProviderConfigured` is false → fanout skips that provider → zero samples for it from CF.
- **SSH/CF deploys can flake.** Re-running the CF deploy is safe (idempotent on secrets, image push is content-addressed). If a transient failure aborts mid-flight, just re-run.
- **Container cold-start ~30–90s.** After a successful `wrangler deploy` with a new tag, give CF Containers up to ~2 min to spin up new instances before judging "is it producing samples."
- **CRITICAL: a CF deploy does NOT restart the container — you must trigger it.** The
  Durable-Object-backed container only (re)boots on an inbound request or its cron
  (`0 */6 * * *`, every 6h). `wrangler deploy` rolls the image/config but leaves any
  running instance as-is and does **not** start a stopped one. So after deploy —
  **and especially after the running instance has exited/crashed** — CF can sit dark
  for up to 6h until the cron fires. **Always hit the healthcheck right after a CF
  deploy to boot the new image immediately:**
  ```bash
  curl https://rpc-bench-worker-cf.<your-subdomain>.workers.dev/
  # → {"phase":"worker_running","boot_at":"...","uptime_s":1,...} means it just started
  ```
  If the running container has exited or crashed (e.g. on a generator rollout that
  introduced methods the old code doesn't recognize), `wrangler deploy` alone —
  even with a fresh tag — does NOT bring it back, because nothing re-triggers the
  DO. A single healthcheck `curl` boots it onto the new image. If CF shows zero
  samples after a deploy, curl the healthcheck **before** assuming the deploy failed.

### TeraSwitch (bare-metal SSH + systemd)
- **Reads from working tree.** `deploy-tsw.sh` rsyncs the repo (uncommitted changes included) + installs/restarts a systemd unit. The remote `/etc/rpc-bench-worker.env` is composed from `/tmp/rpc-bench-worker.env.shared`.
- **SSH flakes are common.** "Connection reset by peer" mid-rsync just retry — the script is idempotent.
- **The orchestrator script bails on first TSW failure** (`set -e`), which prevents CF from deploying afterward. If one TSW box is flaky, run CF separately:
  ```bash
  SKIP_AWS=1 SKIP_TSW=1 SKIP_GCP=1 bash infra/scripts/deploy-all-workers.sh
  ```
  Then retry the individual TSW box:
  ```bash
  bash infra/bare-metal/deploy-tsw.sh <ip> <region> <egress_path>
  ```

---

## Known landmines (bug → cause → fix pattern)

### `samples_exclusion_chk` constraint violation
**Symptom:** Workers crashloop with `null value` / `violates check constraint "samples_exclusion_chk"` and a row dump showing a new `exclusion_reason` value.

**Cause:** The CHECK constraint in `0002_archive_and_constraints.sql` hard-codes the allowed values. Adding a new `exclusion_reason` to `packages/shared/src/types.ts` without updating the constraint = workers can't insert.

**Fix:** Write a follow-up migration that drops + re-adds the constraint with the new value list. See `0014_v2_constraints.sql` for the pattern.

**Prevention:** Any change to the `ExclusionReason` union or `ChallengeStatus` union in `types.ts` needs a paired migration.

### `assertAuditorIndependent()` empty `benchHosts`
**Symptom:** Generator starts cleanly with no `[auditor-check] WARN`, even though `UTILITY_RPC_URL` is pointed at a panel-member host.

**Cause:** The assertion compares against `BENCHMARKED_PROVIDERS` URLs resolved from the current process env. If panel URLs (e.g. `HELIUS_GATEKEEPER_URL`) aren't bound on the generator's task def, `benchHosts` is empty and no overlap is detected — the assertion silently passes.

**Fix:** Bind every panel provider's URL key on the generator's `secretEnv` list (even though the generator doesn't actually CALL those endpoints — it's purely for the host-string comparison).

**Prevention:** Keep `generator-stack.ts` `secretEnv` list as a superset of all panel URL keys.

### Eligibility NULL crash
**Symptom:** `[rollup] PostgresError: null value in column "correctness" of relation "eligibility" violates not-null constraint`. Crashes the rollup mid-tick → finality re-verification (or anything else at the tail of the tick) never runs.

**Cause:** `refreshEligibility` computes `avg(correctness_rate)`. When ALL matching `rollups_5m` rows have NULL `correctness_rate` (e.g. a provider × method × region with only ambiguous samples — `tier_method_unsupported`), `avg()` returns NULL. The eligibility table has `correctness real NOT NULL`.

**Fix:** `COALESCE(avg(correctness_rate), 0)::real` (and same for `success_rate`).

**Prevention:** Any aggregate column going into a `NOT NULL` target needs COALESCE for the empty-input case.

### Slow rollup blocks finality job (and anything else at tail)
**Symptom:** `consensus_audit` stays empty even though challenges are eligible.

**Cause:** `runRollupTick` is a single sequential pipeline; the leaderboard CTE alone can exceed 5 min under heavy traffic, and the in-flight lock skips overlapping firings. Anything at the END of the tick rarely runs.

**Fix:** Decouple critical periodic jobs onto their own `setInterval` (see `runFinalityRecheck` in `apps/generator/src/rollup.ts` + the standalone interval in `index.ts`).

**Prevention:** Don't chain a sub-job that should run reliably onto the end of a long-running periodic. Keep the rollup pipeline for "things that must happen in order" and use separate intervals for "things that should fire on their own schedule."

### Auditor cross-check misfires on `getSlot`
**Symptom:** `getSlot` shows 50–60% success rate while all other methods are at ~100%. Per-provider `success_pct` tied across all panel members at the same low percentage.

**Cause:** Auditor reference captured at challenge generation (t=0); worker fanout happens at t+δ (up to 30s). Solana advances ~2.5 slots/sec. The default consensus tolerance is 4 slots — too tight for the t+δ gap.

**Fix:** Use a wider tolerance for the auditor cross-check than for consensus voting. `slotProjectionsMatchAuditor` (150 slots) for the auditor check; `slotProjectionsMatch` (4 slots) for parallel-queried consensus. See `packages/runner/src/record.ts:matchPredicateForMethod` vs `auditorMatchPredicateForMethod`.

**Prevention:** For any time-sensitive method, the auditor predicate's tolerance must absorb the worst-case t+δ between auditor capture and worker fanout. Sigs handles this via tip-anchored Jaccard already; immutable methods don't need it.

### `tip_minus_5` bucket filter
**Symptom:** Finality re-verification skips a bucket you thought it covered, or includes a bucket whose answer isn't finalized.

**Cause:** Bucket names use `<bucket>__<low/high>` suffix pattern. A filter like `bucket != 'tip_minus_5'` matches all the `tip_minus_5__low` and `tip_minus_5__high` actual values (they aren't the literal string). Use `bucket NOT LIKE 'tip_minus_5%'`.

**Prevention:** Bucket filters should use `LIKE` patterns against the suffix family, not equality against the family name.

---

## Common recoveries

### Generator saturation
Symptom: every dispatch tick exceeds its 25s budget, the no-challenges watchdog
restarts the generator task repeatedly, and the dashboard's challenge feed
freezes (the web app is fine — the leader is starved). First response: check
tick-duration logs and the task's CPU allocation (raising it resolves the
common case). Further mitigations: move the generator's read paths to pooled
connections and set a statement_timeout so a slow query can't absorb the whole
tick.

### Rollback
Code rollback is `git revert` + redeploy generator + workers in the standard order. The DB rollback is forward-only — schema migrations create new tables (`consensus_log`, `consensus_audit`) and drop one column (`providers.quorum_eligible`). The legacy `quorum_log` is preserved, so `/raw` of older challenges still renders. No data loss.

### Auditor outage
If the auditor (utility endpoint) goes down, every challenge's auditor cross-check returns `auditor_unavailable`. Samples are still scored on consensus alone (correctness denominators are unaffected). The dashboard's "Consensus integrity" panel shows the `auditor-down` rate spike, which is the operator signal.

To recover: confirm the auditor endpoint is healthy, or swap `UTILITY_RPC_URL` to a backup endpoint and restart the generator. See § Roadmap: provisioning a panel-independent auditor removes the single-auditor dependency.

### Worker stops emitting samples
1. `worker_heartbeat` table: is the worker beating? If yes, dispatch issue; if no, container/host issue.
2. CF specifically: hit `https://rpc-bench-worker-cf.<your-subdomain>.workers.dev/healthcheck` to see the boot phase + worker_pid.
3. AWS: `aws logs tail RpcBenchWorker*-<region>` for crash loops.
4. TSW: `ssh ubuntu@<box> 'journalctl -u rpc-bench-worker -n 100'`.

### CDK CloudFormation stuck `UPDATE_IN_PROGRESS`
`aws cloudformation describe-stack-events ...` shows what step. Usually waiting for ECS task drain (~3–5 min). If `UPDATE_ROLLBACK_IN_PROGRESS`, the deploy failed — check ECS service events for the rollback reason.

---

## Quick reference: full prod deploy after a methodology change

**Auth prerequisites — refresh ALL THREE before a fleet deploy** (each cloud uses
a different credential; an expired/insufficient one aborts that tier and, under
`set -e`, everything after it):

```bash
aws sso login --profile "$AWS_PROFILE"   # AWS (CDK/ECS) + the shared-env rebuild path
gcloud auth login                        # GCP (terraform mints a token via `gcloud auth print-access-token`)
wrangler login                           # Cloudflare (Workers + Containers)
```

- **`wrangler login` is mandatory and easy to forget.** `deploy-cf.sh` calls
  `wrangler containers push`, which needs the **Containers/Cloudchamber** scope. A
  stale session or an API token without it fails with `403 Forbidden →
  "cloudchamber push failed"` at the push step (and `wrangler whoami` can't list
  accounts). Fix: `unset CLOUDFLARE_API_TOKEN` (an exported token shadows the
  OAuth session), then `wrangler logout && wrangler login`; or mint an API token
  with **Containers:Edit + Workers Scripts:Edit + Account Settings:Read**. The
  account ID is configured in `deploy-cf.sh`, so a 403 is always a scope problem,
  not a wrong-account one.

```bash
# 1. DB
pnpm db:migrate

# 2. Generator (us-east-2 home region)
cd infra/cdk
cdk deploy RpcBenchGenerator --profile "$AWS_PROFILE" --exclusively --require-approval never
cd ../..

# 3. AWS workers (3 regions × A/B lanes)
cd infra/cdk
cdk deploy RpcBenchWorkerA-us-east-2 RpcBenchWorkerB-us-east-2 \
            RpcBenchWorkerA-eu-central-1 RpcBenchWorkerB-eu-central-1 \
            RpcBenchWorkerA-ap-northeast-1 RpcBenchWorkerB-ap-northeast-1 \
  --profile "$AWS_PROFILE" --exclusively --require-approval never --concurrency 1
cd ../..

# 4. GCP (force unique tag when working tree is dirty)
URI=$(bash infra/gcp/build-image.sh "$(date +%s)")
cd infra/gcp/terraform
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)
terraform apply -input=false -auto-approve -var="project_id=$PROJECT_ID" -var="worker_image=$URI"
cd ../../..

# 5. TSW + CF (force unique CF tag when working tree is dirty)
# TSW box IPs come from your inventory (infra/bare-metal/hosts.env, gitignored).
TAG="cf-$(date +%s)" bash infra/cloudflare/deploy-cf.sh
bash infra/bare-metal/deploy-tsw.sh <box-ip> <region> <egress_path>   # one per box

# 6. Verify
pnpm --filter @rpcbench/db exec tsx ../../infra/scripts/verify-deploy.ts
```

**Verifying a new provider rollout specifically:**
```sql
SELECT worker_provider, count(*) FROM samples
WHERE provider_id = '<new>' AND started_at > now() - interval '2 minutes'
GROUP BY 1;
```
All four `worker_provider` values (aws, cloudflare, gcp, teraswitch) should appear. A missing cloud = its deploy path didn't get the env var.

---

## System inventory (where data + secrets actually live)

| Surface | Where | Notes |
|---|---|---|
| Postgres | Neon | Pooled URL for workers (transaction pooler, no prepared statements); direct URL for generator + migrations. Point-in-time recovery via Neon. |
| Secrets (canonical) | AWS Secrets Manager `rpcbench/env` (home region, replicated to the worker regions) | Single JSON blob. Read by AWS task defs + by the shared-env rebuild path for TSW/CF/GCP. |
| Secrets (GCP mirror) | GCP Secret Manager (the worker project) | One secret per key. Seeded via `infra/gcp/seed-secrets.sh` from `/tmp/rpc-bench-worker.env.shared`. Auto-replicated across GCP regions. |
| Secrets (CF mirror) | Cloudflare Worker secrets (set via `wrangler secret put` from `deploy-cf.sh`) | **Reminder:** these are Worker-scope; the CF Container only sees them via the manual proxy in `infra/cloudflare/src/index.ts`. |
| Worker code (AWS) | ECS image built by CDK from working tree | One stack per region (us-east-2 / eu-central-1 / ap-northeast-1), one service per egress lane (A/B). |
| Worker code (GCP) | Artifact Registry image `us-central1-docker.pkg.dev/<project>/rpc-bench/worker` | Cloud Run services (one per region), each reads the image by tag. |
| Worker code (CF) | Cloudflare managed registry image `rpc-bench-worker-cf`, wrapped by a Worker + Durable Object | Lanes via `max_instances`; CF scheduler places each at a different PoP. |
| Worker code (TSW) | Bare-metal box, code rsync'd to `/opt/rpc-perf-dash`, run via systemd unit `rpc-bench-worker.service` | One box per region (inventory in the gitignored `infra/bare-metal/hosts.env`). |
| Generator code | ECS Fargate (home region only) | 1 active + 1 hot standby via Postgres advisory-lock leader election. |
| Web app | Vercel | Reads from Neon only. Decoupled from infra ops — can deploy independently. |

---

## Methodology versioning

`METHODOLOGY_VERSION` in `packages/shared/src/timing.ts` is the integer fork key. Bumping it:

- **Forks the rollup tables** — all `rollups_*`, `leaderboard_agg_*`, `leaderboard_challenges_*`, `leaderboard_failures_*`, `eligibility` are keyed by `methodology_version`. Pre-bump rows stay; post-bump rows are written under the new version. The web app reads the current version; historical leaderboards stay coherent.
- **Doesn't re-score historical samples.** No backfill is run by the bump itself.
- **Should be paired with a `methodology_versions` row** in the migration (see `0013_consensus_model.sql`) describing what changed.

**When to bump:**
- Scoring formula change (weights, components)
- Projection rule change (what counts as "same answer")
- Eligibility threshold change at the gate (loosening doesn't need a bump if it's TEST_MODE-only)
- Consensus rule change

**When NOT to bump:**
- Operational toggles (auditor endpoint swap, rate-limit tuning)
- UI changes
- Pure bug fixes that restore the documented behavior

---

## Conventions that bite

### Migrations
- Idempotent only: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... DROP COLUMN IF EXISTS`, `ON CONFLICT DO NOTHING/UPDATE`, `INSERT ... ON CONFLICT`. The migrator (`packages/db/src/migrate.ts`) records applied filenames in `schema_migrations` but does not have rollback or transaction-rollback support — a half-failed migration leaves DB state partial.
- Wrap multi-statement migrations in `BEGIN; ... COMMIT;` so partial application is rolled back automatically. See `0013_consensus_model.sql` for the pattern.
- Any change to `ExclusionReason` or `ChallengeStatus` unions in `types.ts` **must** be paired with an `ALTER TABLE ... DROP CONSTRAINT + ADD CONSTRAINT` migration extending the CHECK to accept the new values. Forgetting this = workers crashloop on insert.

### `paramsAsArray` per-method branch
`apps/generator/src/index.ts` and `apps/generator/src/benchmark.ts` both have `paramsAsArray(method, params)`. Every JSON-RPC method needs an **explicit branch**: the final `getSignaturesForAddress` clause is a fallthrough that silently destructures as `{address, options}`. Adding a new method without adding a branch means the generator emits `[undefined, undefined]` and every challenge is malformed.

### Generator HA expected behavior
- One task is leader (`acquired leader lock pid=...`). The other is standby (`not leader, waiting for stale heartbeat...` looping every 15s — this is normal, not an error).
- Failover happens via Postgres advisory lock + a 15s eviction window. If the leader's TLS connection drops, the standby promotes within ~30s.
- **Watchdog:** the leader self-exits after 5 min of no new challenges. ECS restarts the task. If you see the same task PID restarting repeatedly, that's the watchdog — investigate the auditor (it derives challenge params + freshness reference).

### `TEST_MODE=1` env var
Loosens eligibility thresholds for fresh dashboard rendering during local dev. **NEVER set in prod** — weakens the public eligibility gate. The generator logs a startup warning when `TEST_MODE=1` is observed.

### Partition management
`samples` and `samples_archived` are daily-partitioned (`samples_YYYYMMDD`). `apps/generator/src/partitions.ts` runs `ensurePartitions(db)` at startup and every 6h, creating tomorrow's partition ahead of time. **Failure mode:** if partitions aren't created before midnight UTC, the first sample after midnight fails the partition lookup and the worker errors. The watchdog catches the resulting silence within 5 min.

### DB connection modes (Neon)
- **Pooled** (`NEON_DATABASE_URL_POOLED`, the `-pooler` URL): for workers. High concurrency, transaction-pooler mode → **prepared statements are unsupported**. The drizzle config explicitly disables them.
- **Direct** (`NEON_DATABASE_URL_DIRECT` / `_UNPOOLED`): for the generator + migrations + the CLI benchmark. Long-lived connection, full SQL support.

### Storage & retention (keep the DB bounded)
Every table has explicit retention, tiered to exactly what the dashboard reads (max display window is 720h / 30d; granularity coarsens as the window widens — see `apps/web/src/lib/chartData.ts`). The generator owns all of it:

| Data | Retention | Where | Reader that sets the floor |
|---|---|---|---|
| `challenges.reference_response` (JSON payload) | **6h, then nulled** | `trimReferenceResponses` (`maintenance.ts`) | worker at claim (~30s window); `/raw` page shows "trimmed" past 6h. `reference_hash` (used by scoring + `runFinalityRecheck`) is kept forever. |
| `challenges` rows (+ FK children) | 31d | `pruneControlTables` (`maintenance.ts`) | `/challenges` (≤720h). Cascades to `challenge_assignments`, `consensus_log`, `consensus_audit`, `quorum_log`. |
| `eligibility` | 31d | `pruneControlTables` | write-only (gates derived inline via `eligibilityFloors`); pruned by `window_end`. |
| `rollups_5m` | **2d** | `pruneOldRollups5m` (`rollup.ts`) | chart ≤24h + eligibility's 4h window. |
| `rollups_1h` | 8d | `pruneOldRollups1h1d` | chart 24h–7d (also `provider/[id]` 24h). |
| `rollups_1d` | 31d | `pruneOldRollups1h1d` | chart >7d–30d. |
| `leaderboard_*_1h`, `latency_histogram_1h` | 8d | `pruneLeaderboard` | leaderboard/API ≤7d. |
| `leaderboard_*_1d`, `latency_histogram_1d` | 31d | `pruneLeaderboard` | leaderboard/API >7d–30d. |
| `samples` / `samples_archived` | 30d / 90d | `partitions.ts` (DROP partition) | `/challenges` joins samples ≤720h. Unchanged — see § Partition management. |

The `reference_response` trim + control-table prune run on a dedicated 5-min interval (`runMaintenance`), decoupled from the rollup tick (the leaderboard CTE there can overrun and starve tail work). Both are batched (`ctid IN (SELECT … LIMIT n)`) and capped per firing, so the first post-deploy run drains the backlog over several ticks rather than one giant transaction. The trim's inner SELECT is backed by the partial index `challenges_ref_pending_idx`, and the eligibility prune by `eligibility_window_end_idx` (both migration 0022). The trim SELECT carries an `ORDER BY generated_at` that is **load-bearing**: non-null payloads are almost all <6h old, so the planner overestimates the `reference_response IS NOT NULL AND generated_at < 6h` match count (assumes the two predicates are independent) and, under `LIMIT`, would otherwise pick a full ~1.3GB seq scan of `challenges` every 5 min. The `ORDER BY` forces use of the partial index's ordering, bounding the scan to the genuinely-old rows. `ANALYZE` alone does **not** fix this (it's a cross-predicate correlation, not stale single-column stats) — do not remove the `ORDER BY`.

### One-time storage reclaim (nulling/deleting alone won't shrink Neon)
Postgres marks tuples dead on UPDATE/DELETE but doesn't return the space to the OS, and Neon additionally retains old page versions for its history/PITR window. To actually reclaim the historical `reference_response` payload after the trim job has drained the backlog:
1. Confirm the trim has caught up: `SELECT count(*) FROM challenges WHERE reference_response IS NOT NULL AND generated_at < now() - interval '6 hours'` should be ~0.
2. Physically rewrite `challenges` to drop the dead TOAST. Preferred: **pg_repack** (online, no long lock) — `CREATE EXTENSION IF NOT EXISTS pg_repack;` then `pg_repack -t challenges -d neondb`. If pg_repack isn't available on the Neon plan, fall back to `VACUUM FULL challenges` in a low-traffic window (takes an `ACCESS EXCLUSIVE` lock → blocks challenge inserts for the rewrite duration).
3. Reduce the Neon **history/PITR retention** window (Neon console → project settings) so the freed pages age out — required for the reclaim (and the "History" line) to actually drop.
4. Verify with `pg_database_size(current_database())` and the per-table `pg_total_relation_size` query.

---

## Adding a benchmarked method

If you add a new JSON-RPC method to `packages/shared/src/types.ts:Method`:

1. Write the per-method handler in `packages/methods/src/<method>.ts` exporting `handlers: MethodHandlers<P, R>` (deriveChallenge / project / classify / buckets).
2. Register in `packages/methods/src/index.ts` `HANDLERS` map.
3. Add a `paramsAsArray` branch in BOTH `apps/generator/src/index.ts` and `apps/generator/src/benchmark.ts`.
4. Add to the per-method tables in `docs/methodology.md` § Projection & equivalence and § Deployment status.
5. If the method's auditor cross-check needs special tolerance handling (like `getSlot`'s time-drift problem), add it to `auditorMatchPredicateForMethod` in `packages/runner/src/record.ts`.
6. Bump `METHODOLOGY_VERSION` if the method changes the score shape.

---

## Time-to-effect after each deploy

So you don't panic at the 30-second mark:

| Layer | Cold-start / rollout time |
|---|---|
| DB migration | < 1s (most), tens of seconds (heavy ALTER on `samples`) |
| Generator (ECS task replace) | ~2–5 min (ECS draining + new task health check) |
| AWS worker (ECS service rollover) | ~2–5 min per region |
| GCP Cloud Run new revision | ~30–60s after terraform apply finishes |
| CF Container instance | ~30–90s for the new instance to bind and start polling |
| TSW systemd restart | ~5–15s |
| Vercel web app | ~1–2 min per deploy |

For verification: wait at least 2 min after the last worker layer finishes before judging "did the new provider show up." `worker_heartbeat` freshness is the leading indicator (within 5–10s); `samples` lag the heartbeat by the polling interval (~30–60s).

---

## Web app (Vercel)

Read-only against the Neon DB. Independent of all other deploys.

- **Deploys are manual:** `vercel --prod` from the repo ROOT (running it from a
  subdirectory creates a stray Vercel project). Git auto-deploy is not
  connected.
- **Env vars** in Vercel project settings: `NEON_DATABASE_URL_POOLED`, `NEON_DATABASE_URL_DIRECT`. Same Neon project as the workers.
- After deploying a methodology bump to the backend, redeploy the web app so the UI surfaces that key off the new version (consensus-integrity panel, auditor chips, etc.) pick it up.

---

## K-sampling (dispatch fan-out)

Each challenge is dispatched to **K = 3** randomly-sampled active vantages (`VANTAGE_SAMPLE_SIZE` in `apps/generator/src/index.ts`), not to every active vantage. The full-fanout pattern overshoots worker claim throughput ~3x — excess assignments expire unclaimed and produce no samples.

Why this is safe operationally:
- Per (provider × method × region × 4h): ~20-300x the eligibility floor (50 samples).
- Consensus mechanism is per (vantage × mode), unaffected by K.
- Win-rate aggregates over many challenges; long-window unaffected. Short-window variance increases.
- Slow lanes (CF/lax) still slightly over capacity at K=3 uniform; weighted K-sampling (see § Roadmap) would close the residual. Track via `worker_provider × pct_done` in the verifier.

Tuning K up or down:
- Lower K → less worker load, less data density per region. K=2 puts `getProgramAccounts` in 1-vantage regions marginally below the 50-sample floor.
- Higher K → more worker load, faster eligibility convergence but risks regrowing the unclaimed queue.
- Adaptive K based on observed claim rate is on the roadmap — see § Roadmap.

Companion: `BACKPRESSURE_THRESHOLD` (currently 500 still-claimable unclaimed) skips a tick when workers fall behind. Counts only assignments still within their TTL — zombie unclaimed past TTL don't count (otherwise an accumulated zombie pile could freeze dispatch forever). Should never fire in steady state; logs `back-pressure skip` when it does.

Companion: `expireStaleChallenges` + `expireStaleAssignments` crons run every minute (and once at startup), flipping `unclaimed AND past TTL` → `'expired'` on the assignments and `'ready' AND past TTL AND no samples` → `'expired'` on the parent challenges. Without these the UI says "dispatched" forever for stranded rows AND the back-pressure check is fooled by zombie pile-up. The startup run is critical: a deploy after an outage would otherwise see an enormous zombie queue and back-pressure-skip every tick.

## Roadmap

Known operator-followup items:

- **Auditor independence.** Provision a panel-independent auditor URL and unset `AUDITOR_PANEL_OVERLAP_OK=1`. When the auditor shares an operator with a panel member, the consensus cross-check is self-refereeing on challenges that member serves. Scoring itself is unaffected (correctness is decided by panel majority); the finality re-verification job retains full integrity either way.
- **Weighted K-sampling.** Dispatch probability ∝ recent claim rate per vantage, to eliminate the CF/lax residual backlog left by uniform K=3.
