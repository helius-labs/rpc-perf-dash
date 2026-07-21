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
   new challenge format. Must redeploy BEFORE workers: a worker running old code
   against the new schema would error, and a new-code worker reading old-format
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

The worker-secret key set (the pooled Neon URL + the panel provider URLs) has a
**single source of truth**: `WORKER_SECRET_KEYS` in
`packages/shared/src/env-keys.ts`, derived from the provider registry
(`BENCHMARKED_PROVIDERS`). The TS deploy consumers **import** it (so they can't
drift); the two lists that can't import — terraform `local.secret_keys` and the
`seed-secrets.sh` `WORKER_SECRETS` filter — are asserted against it by
`packages/shared/src/env-keys.test.ts`, so **CI fails on drift** instead of a
cloud going quietly sample-less. Values come from `.env` / `.env.local` — the
shared env file and the AWS blob are both generated from it.

(The generator task def does NOT bind panel provider keys — only the utility
endpoint. `GENERATOR_SECRET` and `UTILITY_RPC_URL` are generator-only and never
bound on workers.)

**Adding a NEW provider** touches these places:

| # | Location | What to edit |
|---|---|---|
| 1 | `packages/shared/src/providers.ts` | Add a `ProviderRow` with `endpoints: [{url: "env:NEW_PROVIDER_URL"}]`. `WORKER_SECRET_KEYS` / `PANEL_ENV_KEYS` derive from this. |
| 2 | `.env` / `.env.local` | Set `NEW_PROVIDER_URL=<full url>`. |
| 3 | `infra/gcp/terraform/main.tf` `local.secret_keys` | Add the key (HCL can't import; the parity test flags a miss). Terraform creates the Secret Manager secret + IAM binding. |
| 4 | `infra/gcp/seed-secrets.sh` `WORKER_SECRETS` | Add the key (bash filter; the parity test flags a miss). |
| 5 | `infra/cdk/lib/secrets-stack.ts` template | Add the key so a fresh `rpcbench/env` seeds it (internal AWS only). |

The AWS worker binding (`util.ts` `PANEL_SECRET_KEYS`) and the CF Worker→Container
proxy (`infra/cloudflare/src/index.ts`) now **auto-derive** from
`PANEL_ENV_KEYS` / `WORKER_SECRET_KEYS` — no longer hand-edited.

**Then provision + deploy** — identical to a value change (see
[Changing a provider endpoint](#changing-a-provider-endpoint-value-only)):
`pnpm build:shared-env` → redeploy the fleets → `pnpm seed:aws` (internal mirror).

**Verifier:** after a rollout, query
```sql
SELECT worker_provider, count(*) FROM samples
WHERE provider_id = '<new_provider>' AND started_at > now() - interval '2 min'
GROUP BY 1;
```
A cloud missing from the result means its deploy path didn't get the env var.

### Building the shared env file

`/tmp/rpc-bench-worker.env.shared` — the KEY=VAL file that `deploy-cf.sh` and
`deploy-tsw.sh` consume — is generated from local env, **no AWS required**:

```bash
pnpm build:shared-env             # from .env / .env.local (default; self-serve)
pnpm build:shared-env --from aws  # pull rpcbench/env instead (internal operators)
```

It emits exactly `WORKER_SECRET_KEYS`, so the shared file can't drift from the
provider registry. (This replaces the old hand-rolled `aws secretsmanager
get-secret-value | python3` snippet.)

---

## Per-cloud deploy gotchas

### AWS (CDK / ECS Fargate)
- Secrets bind in the task def. A new `secretEnv()` key needs a `cdk deploy` of the worker stack; `put-secret-value` alone won't expose it to the container.
- `cdk deploy` builds the image from the working tree (uncommitted changes included).
- Deploy regions serially, us-east-2 (home) first, so the generator is on new code before workers ramp. "Failed to publish asset" is usually transient — retry the failed region.

### GCP (Cloud Run + Terraform + Artifact Registry)
- Cloud Run won't recycle on an unchanged image tag. `build-image.sh` tags with the short SHA, so uncommitted changes push new layers under the same tag → no new revision → old code keeps serving. Force a unique tag: `URI=$(bash infra/gcp/build-image.sh "$(date +%s)")`.
- Adding a secret is two-phase: terraform apply creates the (empty) secret and Cloud Run fails to start (no `versions/latest` yet), then `seed-secrets.sh` adds a version, then terraform apply again with a fresh tag to roll it.
- Auth: `gcloud auth print-access-token` exports `GOOGLE_OAUTH_ACCESS_TOKEN` for the terraform google provider (needed when org policy blocks Application Default Credentials).

### Cloudflare (Workers + Containers)
- Run `wrangler login` first (Containers:Edit scope). Without it, `wrangler containers push` 403s with `"cloudchamber push failed"` — see the auth block under "Quick reference".
- Always deploy via `deploy-cf.sh`, never raw `wrangler deploy`: `wrangler.jsonc` carries an `__IMAGE_TAG__` placeholder, so a raw deploy references a non-existent image. The script builds, pushes, substitutes the tag, and deploys.
- Same unchanged-tag problem as GCP: with uncommitted changes wrangler prints "no changes" and running instances keep the old env. Force a tag: `TAG="cf-$(date +%s)" bash infra/cloudflare/deploy-cf.sh`.
- Worker secrets do NOT propagate to the container automatically. The `WorkerContainer` constructor in `infra/cloudflare/src/index.ts` copies them in by iterating `WORKER_SECRET_KEYS` (single source of truth), so a new provider's URL forwards automatically once it's in the registry and seeded via `wrangler secret put` (done by `deploy-cf.sh`). You no longer hand-list keys here — but the value must still be present in the shared env file (`pnpm build:shared-env`), or that provider resolves to null → fanout skips it → zero CF samples for it.
- A CF deploy does NOT restart the container. The Durable-Object-backed container only (re)boots on an inbound request or its 6-hourly cron — `wrangler deploy` rolls the image but won't start a stopped instance, so CF can sit dark up to 6h. After every deploy, curl the healthcheck to boot the new image now:
  ```bash
  curl https://rpc-bench-worker-cf.<your-subdomain>.workers.dev/
  # {"phase":"worker_running","uptime_s":1,...} = just started
  ```
  This is also the first check when CF shows zero samples after a deploy — curl it before assuming the deploy failed. New instances also cold-start ~30–90s, so allow ~2 min before judging output. Re-running a deploy is safe (secrets idempotent, image push content-addressed).

### TeraSwitch (bare-metal SSH + systemd)
- `deploy-tsw.sh` rsyncs the repo (uncommitted changes included) and restarts a systemd unit; the remote `/etc/rpc-bench-worker.env` is composed from `/tmp/rpc-bench-worker.env.shared`. SSH flakes ("Connection reset by peer") — just retry, it's idempotent.
- The orchestrator runs `set -e`, so a failing TSW box aborts the run before CF deploys. Skip the others and retry the box on its own:
  ```bash
  SKIP_AWS=1 SKIP_TSW=1 SKIP_GCP=1 bash infra/scripts/deploy-all-workers.sh
  bash infra/bare-metal/deploy-tsw.sh <ip> <region> <egress_path>
  ```

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
Code rollback is `git revert` + redeploy generator + workers in the standard order. The schema is a single hand-owned baseline (`packages/db/src/migrations/0001_initial.sql`) applied to a fresh DB. No data loss on a code rollback.

### Utility endpoint outage
If the utility endpoint (`UTILITY_RPC_URL`) goes down, the generator can't derive challenges from live chain state and challenge production stalls. The dashboard's fleet-health strip shows the "Utility RPC" dot go red, which is the operator signal.

To recover: confirm the endpoint is healthy, or swap `UTILITY_RPC_URL` to a backup endpoint and restart the generator.

### Changing a provider endpoint (value only)

Rotating a key or swapping a panel provider's URL — **no code change, no registry
change**. The env var already exists; you're only changing its value. `.env` (+
`.env.local`) is the source of truth; everything else is regenerated from it.

1. **Edit local env** — update the URL in `.env` (or `.env.local`).
2. **Regenerate the provisioning inputs:**
   ```bash
   pnpm build:shared-env   # writes /tmp/rpc-bench-worker.env.shared (feeds CF, TSW, GCP)
   pnpm seed:aws           # mirrors .env → AWS rpcbench/env (feeds AWS ECS + generator; internal only)
   ```
3. **Redeploy each fleet so it recycles onto the new value** (secrets are read at
   container start). Force a unique image tag on GCP + CF when the tree is dirty:
   ```bash
   # GCP — push the new value into GCP Secret Manager, then roll a fresh revision
   PROJECT_ID=<id> bash infra/gcp/seed-secrets.sh /tmp/rpc-bench-worker.env.shared
   URI=$(bash infra/gcp/build-image.sh "$(date +%s)")
   (cd infra/gcp/terraform && export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) && \
      terraform apply -input=false -auto-approve -var="project_id=$PROJECT_ID" -var="worker_image=$URI")
   # AWS — workers read rpcbench/env (updated by `pnpm seed:aws` above); recycle to pick it up
   (cd infra/cdk && cdk deploy 'RpcBenchWorker*' --profile "$AWS_PROFILE" --exclusively --require-approval never --concurrency 1)
   # Cloudflare — then curl the healthcheck to boot the container now (else dark up to 6h)
   TAG="cf-$(date +%s)" bash infra/cloudflare/deploy-cf.sh
   curl https://rpc-bench-worker-cf.<your-subdomain>.workers.dev/
   # TeraSwitch — one per box
   bash infra/bare-metal/deploy-tsw.sh <ip> <region> <egress_path>
   ```
4. **Verify** per cloud:
   ```sql
   SELECT worker_provider, count(*) FROM samples
   WHERE provider_id = '<provider>' AND started_at > now() - interval '2 min'
   GROUP BY 1;
   ```

**Self-serve (no AWS):** skip `pnpm seed:aws` and the AWS `cdk deploy` step — steps
1–3 (GCP/CF/TSW) + verify are the whole flow, sourced entirely from `.env`.

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

> **Set `$AWS_PROFILE`** to an AWS profile with access to the account that holds
> your worker fleet + the canonical `rpcbench/env` secret. It needs enough
> permissions (e.g. AdministratorAccess) for all `cdk` + shared-env-rebuild steps
> below.

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
  account ID comes from `$CLOUDFLARE_ACCOUNT_ID` (read by `deploy-cf.sh`, which
  fails fast when it's unset), so a 403 is always a scope problem, not a
  wrong-account one.

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
# Build the shared env file first — deploy-cf.sh and deploy-tsw.sh both require
# it. Generated from .env / .env.local (add `--from aws` to source rpcbench/env).
pnpm build:shared-env
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
| Secrets (canonical source) | `.env` / `.env.local` (repo root, gitignored) | **The source of truth.** `pnpm build:shared-env` and `pnpm seed:aws` both regenerate downstream stores from it, so a self-serve deploy needs no AWS. |
| Secrets (AWS mirror) | AWS Secrets Manager `rpcbench/env` (home region, replicated to worker regions) | Single JSON blob (`AWS_ENV_KEYS`). Read by AWS task defs + the generator. Seeded from `.env` via `pnpm seed:aws` (internal). |
| Secrets (GCP mirror) | GCP Secret Manager (the worker project) | One secret per key. Seeded via `infra/gcp/seed-secrets.sh` from `/tmp/rpc-bench-worker.env.shared` (built by `pnpm build:shared-env`). Auto-replicated across GCP regions. |
| Secrets (CF mirror) | Cloudflare Worker secrets (set via `wrangler secret put` from `deploy-cf.sh`) | **Reminder:** Worker-scope; the CF Container gets them via the constructor's `WORKER_SECRET_KEYS` loop in `infra/cloudflare/src/index.ts` (auto-derived, no hand-listing). |
| Worker code (AWS) | ECS image built by CDK from working tree | One stack per region (us-east-2 / eu-central-1 / ap-northeast-1), one service per egress lane (A/B). |
| Worker code (GCP) | Artifact Registry image `us-central1-docker.pkg.dev/<project>/rpc-bench/worker` | Cloud Run services (one per region), each reads the image by tag. |
| Worker code (CF) | Cloudflare managed registry image `rpc-bench-worker-cf`, wrapped by a Worker + Durable Object | Lanes via `max_instances`; CF scheduler places each at a different PoP. |
| Worker code (TSW) | Bare-metal box, code rsync'd to `/opt/rpc-perf-dash`, run via systemd unit `rpc-bench-worker.service` | One box per region (inventory in the gitignored `infra/bare-metal/hosts.env`). |
| Generator code | ECS Fargate (home region only) | 1 active + 1 hot standby via Postgres advisory-lock leader election. |
| Web app | Vercel | Reads from Neon only. Decoupled from infra ops — can deploy independently. |

---

## Runtime behavior & change rules

### Migrations
- Idempotent only: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... DROP COLUMN IF EXISTS`, `ON CONFLICT DO NOTHING/UPDATE`, `INSERT ... ON CONFLICT`. The migrator (`packages/db/src/migrate.ts`) records applied filenames in `schema_migrations` but does not have rollback or transaction-rollback support — a half-failed migration leaves DB state partial.
- Wrap multi-statement migrations in `BEGIN; ... COMMIT;` so partial application is rolled back automatically.
- Any change to `ExclusionReason` or `ChallengeStatus` unions in `types.ts` **must** be paired with an `ALTER TABLE ... DROP CONSTRAINT + ADD CONSTRAINT` migration extending the CHECK to accept the new values. Forgetting this = workers crashloop on insert.

### `paramsAsArray` per-method branch
`paramsAsArray(method, params)` lives in `apps/generator/src/params.ts` (imported by `index.ts`, `benchmark.ts`, and the standalone CLI). Every JSON-RPC method needs an **explicit branch**: the final `getSignaturesForAddress` clause is a fallthrough that silently destructures as `{address, options}`. Adding a new method without adding a branch means the generator emits `[undefined, undefined]` and every challenge is malformed.

### Generator HA expected behavior
- One task is leader (`acquired leader lock pid=...`). The other is standby (`not leader, waiting for stale heartbeat...` looping every 15s — this is normal, not an error).
- Failover happens via Postgres advisory lock + a 15s eviction window. If the leader's TLS connection drops, the standby promotes within ~30s.
- **Watchdog:** the leader self-exits after 5 min of no new challenges. ECS restarts the task. If you see the same task PID restarting repeatedly, that's the watchdog — investigate the utility endpoint (it derives challenge params + the reference tip slot).

### `TEST_MODE=1` env var
Loosens eligibility thresholds for fresh dashboard rendering during local dev. **NEVER set in prod** — weakens the public eligibility gate. The generator logs a startup warning when `TEST_MODE=1` is observed.

### Partition management
`samples` and `samples_archived` are daily-partitioned (`samples_YYYYMMDD`). `apps/generator/src/partitions.ts` runs `ensurePartitions(db)` at startup and every 6h, creating partitions **`PARTITION_LEAD_DAYS` (4) ahead** so a partition is never created just-in-time at the midnight-UTC boundary (a create racing live inserts can take an `ACCESS EXCLUSIVE` lock and convoy every subsequent insert). Guards: the create runs under a short `lock_timeout` (`PARTITION_LOCK_TIMEOUT`) and logs+retries next tick instead of crashing; the sample INSERT path carries its own `statement_timeout`/`lock_timeout` (`insertSamples` in `packages/db/src/samples.ts`) so a stalled insert errors and retries rather than holding a lock; the storage watchdog alerts if no samples are written for 3 min while live.

**Archive contents:** the archival INSERT copies `WHERE raw_response IS NOT NULL`, and `record.ts` keeps `raw_response` only for **honeypot + `correctness_failure`** samples (a provider returned a verifiably-wrong answer against a *valid* consensus). It does NOT keep raw for `no_consensus` / `reliability_failure` / freshness / tier exclusions. This is load-bearing for bounding DB size: keying on `correctness_failure` keeps raw volume proportional to real correctness *disputes* (rare regardless of provider health), whereas keeping raw for any non-`correct` sample is unbounded under a provider outage — when panel members are down, ~100% of samples become `no_consensus`/reliability failures and every full response body is retained. This assumes an HTTP error is never scored `correctness_failure`: `fromHttpResponse` in `packages/runner/src/fanout.ts` maps any `http_status >= 400` to a transport `error` → `reliability_failure`, so a 429/5xx never enters projection or retains raw. Don't let HTTP-error bodies flow into consensus scoring — it re-opens the unbounded-raw path. Full per-provider raw detail lives in `samples` for the **7-day** live window (`/raw?challenge=<id>`); the 30-day view is served by `rollups` at `grain='1d'`, so raw rows drop early.

### DB connection modes (Neon)
- **Pooled** (`NEON_DATABASE_URL_POOLED`, the `-pooler` URL): for workers. High concurrency, transaction-pooler mode → **prepared statements are unsupported**. The drizzle config explicitly disables them.
- **Direct** (`NEON_DATABASE_URL_DIRECT` / `_UNPOOLED`): for the generator + migrations + the CLI benchmark. Long-lived connection, full SQL support.
- **Workers get the pooled URL only.** They open `createDb({ mode: "pooled" })` and never a direct connection, so the direct URL is deliberately NOT bound on any worker deploy path (AWS `NEON_WORKER_SECRET_KEYS` in `infra/cdk/lib/util.ts`, GCP `local.secret_keys`, and the CF container `Env`). Don't re-add it — handing workers the unpooled URL is an unnecessary credential surface.

## Database size & performance

### Storage & retention (keep the DB bounded)
Every table has explicit retention, tiered to exactly what the dashboard reads (max display window is 720h / 30d; granularity coarsens as the window widens — see `apps/web/src/lib/chartData.ts`). The generator owns all of it:

| Data | Retention | Where | Reader that sets the floor |
|---|---|---|---|
| `challenges.reference_response` (JSON payload) | **6h, then nulled** | `trimReferenceResponses` (`maintenance.ts`) | honeypot known-answer payload; `/raw` shows "trimmed" past 6h. Its `reference_hash` is kept forever. Normal challenges carry no reference payload. |
| `challenges` rows (+ FK children) | 31d | `pruneControlTables` (`maintenance.ts`) | `/challenges` (≤720h). Cascades to `challenge_assignments` and `consensus_log`. |
| `eligibility` | 31d | `pruneControlTables` | write-only (gates derived inline via `eligibilityFloors`); pruned by `window_end`. |
| `rollups_5m` | **2d** | `pruneOldRollups5m` (`rollup.ts`) | chart ≤24h + eligibility's 4h window. |
| `rollups` (`grain='1h'`) | 8d | `pruneOldRollups1h1d` | chart 24h–7d (also `provider/[id]` 24h). |
| `rollups` (`grain='1d'`) | 31d | `pruneOldRollups1h1d` | chart >7d–30d. |
| `leaderboard_*`, `latency_histogram` (`grain='1h'`) | 8d | `pruneLeaderboard` | leaderboard/API ≤7d. |
| `leaderboard_*`, `latency_histogram` (`grain='1d'`) | 31d | `pruneLeaderboard` | leaderboard/API >7d–30d. |
| `samples` / `samples_archived` | **7d / 30d** | `partitions.ts` (DROP partition) | raw rows only; the 30-day view is served by `rollups` (`grain='1d'`), not raw samples. `/challenges` per-sample detail (and `/raw`) is limited to the 7-day window; older challenges render from rollups. DROP reclaims space physically + immediately. |

The `reference_response` trim + control-table prune run on a dedicated 5-min interval (`runMaintenance`), decoupled from the rollup tick (the leaderboard CTE there can overrun and starve tail work). Both are batched (`ctid IN (SELECT … LIMIT n)`) and capped per firing, so the first post-deploy run drains the backlog over several ticks rather than one giant transaction. The trim's inner SELECT is backed by the partial index `challenges_ref_pending_idx`, and the eligibility prune by `eligibility_window_end_idx` (both in `0001_initial.sql`). The trim SELECT carries an `ORDER BY generated_at` that is **load-bearing**: non-null payloads are almost all <6h old, so the planner overestimates the `reference_response IS NOT NULL AND generated_at < 6h` match count (assumes the two predicates are independent) and, under `LIMIT`, would otherwise pick a full ~1.3GB seq scan of `challenges` every 5 min. The `ORDER BY` forces use of the partial index's ordering, bounding the scan to the genuinely-old rows. `ANALYZE` alone does **not** fix this (it's a cross-predicate correlation, not stale single-column stats) — do not remove the `ORDER BY`.

### One-time storage reclaim
A DELETE/UPDATE won't shrink the DB: Postgres keeps dead tuples and Neon retains old pages for its history/PITR window. To actually reclaim space after a big cleanup (e.g. the `reference_response` trim):
1. Confirm the cleanup has caught up (e.g. `SELECT count(*) FROM challenges WHERE reference_response IS NOT NULL AND generated_at < now() - interval '6 hours'` ≈ 0).
2. Physically rewrite the table: `pg_repack -t challenges -d neondb` (online, no long lock; `CREATE EXTENSION IF NOT EXISTS pg_repack;` first), or `VACUUM FULL` in a low-traffic window (takes `ACCESS EXCLUSIVE`, blocks inserts during the rewrite).
3. Shrink the Neon history/PITR window (console → project settings) so freed pages age out — required for the reclaim to show up.
4. Verify with `pg_database_size(current_database())`.

### Dashboard read latency (cold rollup pages)
Rollup reads are cheap when their pages are in cache and much slower when read from storage — a query can run tens of ms warm vs. hundreds of ms to seconds cold (worse under a page's parallel fan-out). The rollup working set is several GB while the DB's cache is smaller, so an uncommon filter combo (e.g. a specific `worker_provider`, part of every cache key) hits storage. Levers, in order of impact:
1. **Give the DB more memory** so the rollup working set stays resident (bigger buffer cache) — the biggest lever, brings cold reads near warm. Disable autosuspend so the cache isn't dropped on idle. Weigh against the build-job memory budget below.
2. **Pre-warm cron** (`/api/prewarm`, every minute) keeps the common combos' `unstable_cache` entries and pages hot so no visitor pays the cold read.
3. **`unstable_cache` TTL is 120s** (`leaderboard.ts` / `chartData.ts` `CACHE_TTL_S`) so a burst doesn't expire the entry mid-flight.
4. **Web-read `statement_timeout` ceiling** caps a pathological cold read so it can't pin a connection. Set it as a role default (`ALTER ROLE <web_role> SET statement_timeout='15s'`), not in app config — a transaction pooler ignores/rejects a per-connection `statement_timeout`. The generator's heavy builds override it per-transaction with `SET LOCAL`, so they're unaffected.

### Rollup build-job memory safety (the 1-CU budget)
The dashboard *reads* are rollup-backed and cheap when warm (see the read-latency note above). The memory pressure comes from the generator's *build* jobs that scan raw `samples` every 5 min (`rollupTier`, `rollupLeaderboard`, `refreshEligibility` in `rollup.ts`). Three guards keep them inside a small (1 CU / 4 GB) compute; losing any one risks OOM or temp-disk fill:
1. **Bounded GUCs per job** (`withHeavyGucs`): each heavy build runs in a transaction with `SET LOCAL work_mem='128MB'`, `statement_timeout='600s'`. `SET LOCAL` (not session `SET`) is mandatory — the generator uses the transaction pooler, where session SETs don't persist across checkouts. The 600s ceiling is deliberately generous: the legit leaderboard build (percentile GROUPING SETS + ranked/wins window sorts over a day of correct samples) runs ~40s warm for the agg alone and more cold / on a small compute / under dispatch contention — a 120s cap timed it out at startup (`57014`). 600s still kills the pathological runaway (the original ~800s unbounded spill) while letting the bounded post-fix build finish. **Do NOT add `temp_file_limit` here** — it's a superuser-only (SUSET) GUC and Neon's owner role can't set it (raises `42501 permission denied`, which aborts the whole build transaction). The disk-fill guard is therefore `statement_timeout` + the reduced scan footprint (explicit projection + 1-day lookback); a hard temp cap, if needed, must be set on the Neon compute via the console/API. **Never raise `work_mem` globally** (`ALTER ROLE`/`ALTER DATABASE`): it multiplies across the 20-slot pool and itself causes OOM. As a one-time belt-and-suspenders, set role-level ceilings (run once on the **direct** connection — these are USERSET role GUCs, allowed on Neon, not `ALTER SYSTEM`):
   ```sql
   ALTER ROLE neondb_owner SET statement_timeout = '600s';
   ALTER ROLE neondb_owner SET lock_timeout = '10s';
   ALTER ROLE neondb_owner SET idle_in_transaction_session_timeout = '30s';
   ```
   These cap *every* query (including web reads); 600s is above any legitimate query but below the runaway. `lock_timeout`/`idle_in_transaction` are safe at these values for the generator's short multi-statement build transactions.
2. **Explicit column projection** in the leaderboard base CTEs (NOT `SELECT s.*`): `raw_response` (KB–MB JSONB) must never enter the GROUPING SETS / window-function / percentile sort working set.
3. **Bounded re-scan window**: `rollup1d` + the daily `rollupLeaderboard` use a `"1 day"` lookback (current + just-closed day), not `"2 days"` (which spanned 3 calendar days re-scanned every tick). Safe because the only late `samples` writers finish <~2 min after a bucket closes (bounded by the 30s challenge TTL + worker fanout); a closed day never changes after that. If you ever need to recompute deeper history, run a one-off backfill with a larger lookback — don't widen the steady-state tick.

---

## Adding a benchmarked method

If you add a new JSON-RPC method to `packages/shared/src/types.ts:Method`:

1. Write the per-method handler in `packages/methods/src/<method>.ts` exporting `handlers: MethodHandlers<P, R>` (deriveChallenge / project / classify / buckets).
2. Register in `packages/methods/src/index.ts` `HANDLERS` map.
3. Add a `paramsAsArray` branch in `apps/generator/src/params.ts` (the single shared mapping used by the generator and the CLI).
4. Add to the per-method tables in `docs/methodology.md` § Projection & equivalence and § Deployment status.
5. If the method needs a non-byte-equal consensus predicate (slot/value tolerance, Jaccard), add it to `matchPredicateForMethod` in `packages/runner/src/record.ts`.

---

## Time-to-effect after each deploy

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

Read-only against the DB. Independent of all other deploys.

- **Deploys are automatic on push to `main`** (`apps/web/vercel.json` sets
  `git.deploymentEnabled.main`). A manual `vercel --prod` also works — run it
  from the repo ROOT (running it from a subdirectory creates a stray Vercel
  project).
- **Env vars** in Vercel project settings: `NEON_DATABASE_URL_POOLED`, `NEON_DATABASE_URL_DIRECT`. Same Neon project as the workers.
- After deploying a methodology bump to the backend, redeploy the web app so the UI surfaces that key off the new version (consensus-integrity panel, etc.) pick it up.

---

## K-sampling (dispatch fan-out)

Each challenge is dispatched to **K = 3** randomly-sampled active vantages (`VANTAGE_SAMPLE_SIZE` in `apps/generator/src/index.ts`), not to every active vantage. The full-fanout pattern overshoots worker claim throughput ~3x — excess assignments expire unclaimed and produce no samples.

Why this is safe operationally:
- Per (provider × method × region × 4h): ~20-300x the eligibility floor (50 samples).
- Consensus mechanism is per (vantage × mode), unaffected by K.
- Win-rate aggregates over many challenges; long-window unaffected. Short-window variance increases.
- Slow lanes (CF/lax) still slightly over capacity at K=3 uniform; weighted K-sampling would close the residual. Track via `worker_provider × pct_done` in the verifier.

Tuning K up or down:
- Lower K → less worker load, less data density per region. K=2 puts `getProgramAccounts` in 1-vantage regions marginally below the 50-sample floor.
- Higher K → more worker load, faster eligibility convergence but risks regrowing the unclaimed queue.
- Adaptive K based on observed claim rate is a possible future change.

Companion: `BACKPRESSURE_THRESHOLD` (currently 500 still-claimable unclaimed) skips a tick when workers fall behind. Counts only assignments still within their TTL — zombie unclaimed past TTL don't count (otherwise an accumulated zombie pile could freeze dispatch forever). Should never fire in steady state; logs `back-pressure skip` when it does.

Companion: `expireStaleChallenges` + `expireStaleAssignments` crons run every minute (and once at startup), flipping `unclaimed AND past TTL` → `'expired'` on the assignments and `'ready' AND past TTL AND no samples` → `'expired'` on the parent challenges. Without these the UI says "dispatched" forever for stranded rows AND the back-pressure check is fooled by zombie pile-up. The startup run is critical: a deploy after an outage would otherwise see an enormous zombie queue and back-pressure-skip every tick.
