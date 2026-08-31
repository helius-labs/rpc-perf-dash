# Operations runbook

Things to know before deploying or changing infrastructure: deploy ordering,
the env-var fan-out, per-cloud gotchas, and recovery procedures. Read it
end-to-end before touching `infra/`, `packages/shared/src/providers.ts`, or any
secrets.

## Setup (fresh clone)

`pnpm bootstrap:creds` is the single entry point for both operators and external
contributors — it works with or without AWS access:

```bash
pnpm install
aws sso login --profile "$AWS_PROFILE"   # operators only
pnpm bootstrap:creds
```

With AWS access it pulls `.env` from `rpcbench/env` and deploy config
(`.ops.env` + `infra/bare-metal/hosts.env`) from `rpcbench/ops`, runs
`build:shared-env`, and probes GCP/CF/TSW auth into a `✓/✗/-` checklist. Without
AWS access it copies `.env.example` → `.env` and marks the AWS-only steps skipped.
Deploy config in `rpcbench/ops` is maintained with `pnpm seed:ops` (the ops-side
analogue of `pnpm seed:aws`).

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
   covers all four in parallel; add `--verify` to auto-run the fleet health check
   (`pnpm verify:deploy`) once they finish.
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

**Then provision + deploy — order matters (a new provider adds a NEW secret key,
which neither the quick-ref nor `deploy-all-workers.sh` create).** Unlike a
value-only change, the key exists in *no* secret store yet, so seed BEFORE the
worker deploys or they crashloop:

1. `pnpm build:shared-env` then `pnpm seed:aws` — writes the key into
   `rpcbench/env`. Do this **before** the AWS worker `cdk deploy`; ECS resolves
   the secret at task start and crashloops on a missing key. The scripts now
   print a masked fingerprint of each URL — eyeball it.
2. **GCP is two-phase** (the secret has no version yet): `terraform apply` to
   create the empty secret (Cloud Run fails, expected) →
   `infra/gcp/seed-secrets.sh` to add a version → `terraform apply` again with a
   fresh tag to roll. See the GCP gotcha above.
3. Redeploy the fleets. `deploy-all-workers.sh` deploys code but does **not**
   create/seed secrets — the two steps above must precede it.

For a value-only fix later (rotating the key), see
[Changing a provider endpoint](#changing-a-provider-endpoint-value-only).

**Key source of truth:** `loadEnv` resolves `.env.local` over `.env` (and the
real environment over both). Set the key in whichever file you use, but don't
leave a *different* stale value in the other — `loadEnv` warns on a conflict,
and a wrong value here silently seeds the whole fleet (it once shipped a bad key
that returned `http_401` on every request).

**Verifier — do NOT trust `verify:deploy`'s green alone for a value/key.**
`pnpm verify:deploy` now includes a per-provider liveness gate (fails if a
benchmarked provider is <50% success), but always eyeball the per-provider
breakdown too:
```sql
SELECT worker_provider, status, http_status, count(*)
FROM samples
WHERE provider_id = '<new_provider>' AND started_at > now() - interval '2 min'
GROUP BY 1,2,3 ORDER BY 1;
```
A cloud missing → its deploy path didn't get the env var. All-`http_401`/`403` →
wrong/blocked key (not the WAF). `http_403` on `getTokenLargestAccounts` alone is
fine — that's a legitimately unsupported method, excluded from scoring.

**Contributing your own provider (no fleet).** External contributors never touch
infra — matrix rows 3–5 and everything below are maintainer-only. Two distinct
ways to benchmark a provider locally:

- **CLI (quickest)** — pass the endpoint inline; **no `ProviderRow`, no `.env`**
  needed: `pnpm --filter cli start -- --provider yourname=<url>`.
- **Self-host (Option B)** — run the full generator/worker/DB stack. Here you
  add a `ProviderRow` (row 1) and set its `env:` key in `.env` (row 2); unset
  providers are skipped, configured ones are auto-picked-up.

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
- **Multi-region worker deploy in a SINGLE `cdk deploy` fails on the non-build regions' ECR push** — `tag does not exist` or `An image does not exist locally with the tag: …<region-ecr>…:<hash>`. The build region (us-east-2) publishes fine; eu-central-1 / ap-northeast-1 fail. CDK builds the image once and publishes it to all three regions' ECRs concurrently, but the cross-region step doesn't reliably `docker tag` the local image for the other regions before pushing. **Fix: deploy one region (A+B lanes) per `cdk deploy` command** (see the deploy quick-reference) — single-region deploys build+tag+push in isolation and always work. (The single-region generator deploy never hits this.) *Note: toggling Docker Desktop's "Use containerd for pulling and storing images" changes the exact error text but does NOT fix it — per-region is the fix, and works regardless of the image-store mode.*

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
2. **Regenerate the provisioning inputs** (operators can run `pnpm sync:secrets`,
   which is exactly these two commands):
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

> **If this change ALSO adds a new provider** (a new secret key), this reference
> is not enough on its own: first do the new-key provisioning in
> [Env var propagation matrix](#env-var-propagation-matrix) (seed `rpcbench/env`
> before the AWS worker deploy; GCP two-phase). The steps below assume every
> `WORKER_SECRET_KEY` already has a value in every store.

**Auth prerequisites — refresh ALL THREE before a fleet deploy** (each cloud uses
a different credential; an expired/insufficient one aborts that tier and, under
`set -e`, everything after it):

> **Export the per-cloud deploy vars first** — the commands below reference them
> and fail unhelpfully if unset:
> - `AWS_PROFILE` — an AWS profile with access to the fleet account + the
>   canonical `rpcbench/env` secret (e.g. AdministratorAccess), for all `cdk` +
>   shared-env-rebuild steps.
> - `PROJECT_ID` — the GCP project id (the prod project; see the operator secret
>   store, not committed here). **Required by
>   `build-image.sh` as an env var** (not just the terraform `-var`), so export it,
>   don't only pass it to `terraform apply`.
> - `CLOUDFLARE_ACCOUNT_ID` — from `wrangler whoami`; `deploy-cf.sh` fails fast
>   without it.

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

# 3. AWS workers — ONE region (A+B lanes) per cdk deploy. Deploying all three
#    regions in a single command fails on the non-build regions' ECR push
#    ("tag does not exist" / "An image does not exist locally"): CDK's concurrent
#    cross-region asset publish doesn't reliably re-tag the single built image for
#    the other regions. Per-region isolates each build+tag+push.
cd infra/cdk
cdk deploy RpcBenchWorkerA-us-east-2 RpcBenchWorkerB-us-east-2 \
  --profile "$AWS_PROFILE" --exclusively --require-approval never
cdk deploy RpcBenchWorkerA-eu-central-1 RpcBenchWorkerB-eu-central-1 \
  --profile "$AWS_PROFILE" --exclusively --require-approval never
cdk deploy RpcBenchWorkerA-ap-northeast-1 RpcBenchWorkerB-ap-northeast-1 \
  --profile "$AWS_PROFILE" --exclusively --require-approval never
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
pnpm verify:deploy
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
- **Reads stalled while the leader looks "alive" (heartbeat stale for many minutes, 0 challenges + 0 samples, but workers on all clouds still heartbeating idle):** a runaway heavy query — typically the **read leaderboard-rollup CTE** (`WITH base … -- Explicit projection`) — has saturated the Neon compute (`pg_stat_activity` waits show `IPC/BufferIo`), stalling the generator's DB calls. Frequently kicks off at the **00:00 UTC partition boundary**. The 5-min watchdog may NOT fire here (its own DB write is stuck behind the wedge). **Recovery:** list long-running backends and terminate the runaway rollup —
  ```sql
  SELECT pid, now()-xact_start AS age, wait_event, left(query,80)
  FROM pg_stat_activity WHERE state='active' AND xact_start < now()-interval '5 min';
  -- then, for the rollup/leaderboard pid(s):
  SELECT pg_terminate_backend(<pid>);
  ```
  Reads resume within ~30s once the compute frees up (the generator retries on its next tick — no restart needed). Neon's own `autovacuum` backends can't be terminated by the app role (`42501`) — leave them, they're `VacuumDelay`-throttled and non-blocking. If terminating doesn't free it, restart/resize the Neon compute from the console (undersized compute is the durable root cause — see the storage/percentile notes).

### `TEST_MODE=1` env var
Loosens eligibility thresholds for fresh dashboard rendering during local dev. **NEVER set in prod** — weakens the public eligibility gate. The generator logs a startup warning when `TEST_MODE=1` is observed.

### Partition management
`samples` and `landing_tx_results` are daily-partitioned (`samples_YYYYMMDD`). (`samples_archived` was removed on 2026-08-31 — migration `0003`; see **Raw-response retention** below.) `apps/generator/src/partitions.ts` runs `ensurePartitions(db)` at startup and every 6h, creating partitions **`PARTITION_LEAD_DAYS` (4) ahead** so a partition is never created just-in-time at the midnight-UTC boundary (a create racing live inserts can take an `ACCESS EXCLUSIVE` lock and convoy every subsequent insert). Guards: the create runs under a short `lock_timeout` (`PARTITION_LOCK_TIMEOUT`) and logs+retries next tick instead of crashing; the sample INSERT path carries its own `statement_timeout`/`lock_timeout` (`insertSamples` in `packages/db/src/samples.ts`) so a stalled insert errors and retries rather than holding a lock; the storage watchdog alerts if no samples are written for 3 min while live.

**Raw-response retention:** `record.ts` keeps `raw_response` only for **`correctness_failure`** samples (a provider returned a verifiably-wrong answer against a *valid* consensus) **plus honeypot rows that did NOT pass**. It does NOT keep raw for `no_consensus` / `reliability_failure` / freshness / tier exclusions, nor for honeypot rows that came back `correct`.

Two successive versions of this rule were both unbounded, and the second one is the more instructive failure:

1. *"Keep raw for any non-`correct` sample"* was unbounded under a provider **outage** — when panel members are down, ~100% of samples become `no_consensus`/reliability failures and every full response body was retained. Keying on `correctness_failure` fixed that: a check that can't reach consensus yields `no_consensus`, NOT `correctness_failure`, so raw volume tracks real correctness *disputes*, which stay rare regardless of provider health. This assumes an HTTP error is never scored `correctness_failure`: `fromHttpResponse` in `packages/runner/src/fanout.ts` maps any `http_status >= 400` to a transport `error` → `reliability_failure`, so a 429/5xx never enters projection or retains raw. Don't let HTTP-error bodies flow into consensus scoring — it re-opens that path.

2. *`is_honeypot` alone* was still unbounded **in bytes**. It bounds the row COUNT but not the size of a row, and a `getBlock` body is ~1.8 MB stored / ~3.4 MB detoasted. At ~19k honeypot `getBlock` rows/day that is ~34 GB/day, and **99.75% of those rows are `correct`** (measured 19,083 of 19,130 on 2026-08-30) — i.e. bodies that by definition agreed with the pre-seeded known answer. That one predicate was ~99% of a 2.18 TB database. Narrowing it to honeypot *misses* took the forensic tail from ~34 GB/day to ~115 MB/day.

**The general lesson:** every bound in this repo was on TIME and ROW COUNT (7d/30d/31d partitions, `keepRaw` row predicates) and all of them worked exactly as coded. Nothing bounded BYTES PER ROW. When checking storage, always measure `sum(pg_column_size(col))` per table — not row counts.

Full per-provider raw detail lives in `samples` for the **7-day** live window (`/raw?challenge=<id>`); the 30-day view is served by `rollups` at `grain='1d'`, so raw rows drop early. `/raw` selects `raw_response IS NOT NULL AS has_raw`, never the payload — the page only renders a yes/no presence flag, and selecting the column detoasted ~30 x ~3.4 MB bodies per pageview.

**Why `samples_archived` is gone (2026-08-31).** It held a 30-day tail of every row with a non-null `raw_response` and had **zero readers** — no `SELECT` against it existed anywhere in `apps/` or `packages/`. At removal it was 1837 GB of a 2184 GB database. It also carried a 2x amplification of its own: the archival `INSERT ... SELECT ... ON CONFLICT DO NOTHING` was idempotent in ROWS but not in BYTES, since a re-run re-TOASTs each 1.8 MB body before discovering the conflict, leaving those chunks dead on arrival. `pg_stat` showed exactly **2.00 inserts per live TOAST chunk and ~51% page utilization** on every archive partition, against 1.02 and ~98% for the same rows in `samples`; the copy re-ran because the `DROP TABLE` at the tail of the same `DO` block could fail into the `EXCEPTION` handler, leaving the partition for the next tick to redo. If a >7-day forensic tail is ever wanted again, keep a **narrow projection** (`challenge_id`, `provider_id`, `method`, `response_hash`, `error_code`) — never a full-row copy, or the byte problem returns.

**Deploy order for that removal is load-bearing:** the old `partitions.ts` referenced `'samples_archived'::regclass` OUTSIDE its `EXCEPTION` handler, and `ensurePartitions` is awaited at startup in `index.ts`, so running the OLD generator against a dropped table crashloops the whole fleet. Generator first, then migration `0003`.

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
| `samples` | **7d** | `partitions.ts` (DROP partition) | raw rows only; the 30-day view is served by `rollups` (`grain='1d'`), not raw samples. `/challenges` per-sample detail (and `/raw`) is limited to the 7-day window; older challenges render from rollups. DROP reclaims space physically + immediately. |
| `samples_archived` | **removed** | — | Dropped 2026-08-31 (migration `0003`): 84% of the database, zero readers. See **Raw-response retention** above. |

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

Each challenge is dispatched to **K = 3** randomly-sampled active vantages (`VANTAGE_SAMPLE_SIZE` in `packages/shared/src/timing.ts`), not to every active vantage. The full-fanout pattern overshoots worker claim throughput ~3x — excess assignments expire unclaimed and produce no samples. K=3 sizes the dispatch to the claim rate: **45 combos/tick × 3 = 135 assignments/tick = ~270/min against the ~450/min worker claim rate**, with headroom for slow lanes.

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

## Transaction sends (the /sends board)

The send archetype (migration 0002, `packages/send`, generator send lane +
confirm poll, worker send branch) is gated by **`SENDS_ENABLED`**. When
unset/false: the generator emits no send challenges and runs no confirm poll, the
worker send lane idles, and **no SOL is spent**. The read board is unaffected
either way. **There is no separate confirm service** — confirmation is a poll
loop folded into the generator (it's already a leader-elected singleton).

### Env propagation — send keys
**There are no send-specific worker secrets.** The /sends board == the 5
benchmarked read providers, each with `sends: true` + a `send_endpoints` entry
pointing at its **standard read URL** (`env:HELIUS_URL`, `ALCHEMY_URL`,
`TRITON_URL`, `QUICKNODE_URL`, `CHAINSTACK_URL`) — we measure plain JSON-RPC
`sendTransaction`, no tips, no relays. So `SEND_ENV_KEYS` resolves entirely to
read-panel keys already in `WORKER_SECRET_KEYS` (deduped) — **nothing extra to
seed on any cloud.** `env-keys.test.ts` still guards the terraform/seed-secrets/CDK
lists.

- **`SEND_MASTER_KEYPAIR`** is **generator-only** (in `AWS_ENV_KEYS`, not
  `WORKER_SECRET_KEYS`) — only the leader creates/funds wallets. A Solana CLI
  JSON keypair array. Keep it **distinct from any other master** — a shared
  funder means either system can drain the other.
- **Confirmation has no dedicated secret** — the generator's confirm poll uses
  its existing `UTILITY_RPC_URL` for `getSignatureStatuses`. No Yellowstone/gRPC,
  no separate service to provision.

### Wallet ops
Per-(send target × scenario) signing keys live in the **`send_wallets` DB table**
(workers read them there — NOT Secrets Manager); the generator leader auto-creates
them. The funding tick (every ~300s) tops up any wallet below
`SEND_MIN_BALANCE_LAMPORTS` by `SEND_TOPUP_LAMPORTS` from `SEND_MASTER_KEYPAIR`
(via `SEND_FUNDING_RPC_URL`), and records every balance to
`landing_wallet_balances` for the low-balance alert. **This spends real mainnet
SOL** — monitor the master balance and cap the top-up budget.

### Harvest / SOL recovery
Forward swaps wrap native SOL → WSOL → USDC; **reverses convert USDC → WSOL that is
never unwrapped**, so native SOL migrates one-way into each wallet's WSOL account and
the master drains via top-ups. Harvest (`send/harvest.ts`) is the inverse of funding:
a **generator-leader-only** guarded `setInterval` (default 1 h) that loads the
**existing payer rows** from `send_wallets` (never creates — unlike funding) and, per
wallet, closes the WSOL ATA (`closeAccount`) → rent + wrapped balance return as **native
in the same wallet**, so the next funding tick sees it at/above min and stops topping up.
It partitions those rows **by target** (not by `SEND_SCENARIOS`), so it processes every
payer row regardless of which scenarios this deploy sends. Every on-chain step is gated
on confirmation; a per-wallet failure is logged and skipped.

- **Roster wallets** (payer rows whose target is still in `SEND_TARGET_CONFIGS`, **not**
  gated by the env-filtered `SEND_SCENARIOS` — a scenario disabled this deploy still holds
  WSOL): unwrap in place; sweep to master only *genuine excess* (native `>
  HARVEST_SWEEP_CEILING_LAMPORTS`, leaving `HARVEST_ACTIVE_FLOOR_LAMPORTS` ≥ the funding
  min so a swept wallet never re-enters the top-up band — rarely fires by design).
- **Orphan wallets** (`send_wallets role='payer'` for a target no longer in
  `SEND_TARGET_CONFIGS`): always close the WSOL ATA (reclaims its ~2.04M-lamport rent even
  at 0 wrapped balance — orphans are never reused), then drain native to master down to
  **exactly 0** so the account is purged. Only the USDC ATA rent (~0.002 SOL) stays stranded
  (a non-empty ATA can't be closed; the USDC leg is out of scope).

> **Deploy order when REMOVING / PAUSING a send target: workers first, then the generator.**
> The moment the generator rolls a new image where a target has left the derived send-target
> list, harvest reclassifies that target's wallets as orphans and drains them to 0. Two ways
> a target leaves the list: dropping it from `SEND_TARGET_CONFIGS`, **or** flipping
> `sends: false` on its `ProviderRow` (the likelier "pause this provider" action) — both drop
> it identically. Workers still on the old image would keep trying to send for that target
> with an empty wallet → failed samples on the board. Deploy the workers (target gone/paused)
> **before** the generator so nothing sends for a drained wallet. This is the inverse of the
> add-a-provider order (generator/DB first); adding a target is safe because harvest only ever
> drains *retired* targets. **If the pause is temporary, disable harvest first**
> (`HARVEST_ENABLED=false`) so the wallets aren't drained while the provider is off.

**Third (parked) category — dormant scenarios.** Partitioning is by *target*, so a
wallet whose **scenario** is dropped from `SEND_SCENARIOS` (but whose target is still
configured) stays "roster": it's unwrapped in place but only swept above the 0.05
ceiling, so ~0.03 SOL sits parked and funding never tops it up either. This is
deliberate — `SEND_SCENARIOS` is a per-deploy send filter, not a retirement, so the
scenario may re-enable and the float should stay put. It's the one accepted stranded
amount (~0.03 SOL × the targets, keys retained), not a leak. If a scenario is truly gone
forever, drain those wallets manually.

**What it does / doesn't fix:** harvest stops the **recoverable** outflow (native locked
in WSOL). It does **not** touch the network+pool fee/slippage burn (fewer/smaller swaps is
the only lever there), so success = "funding top-ups go quiet + master decline flattens
toward the fee floor," **not** "master balance rises."

**Env knobs** (`generator-stack.ts`, all non-secret; harvest only runs when
`SENDS_ENABLED`): `HARVEST_ENABLED` (default `true`), `HARVEST_INTERVAL_MS` (`3600000`,
floored at 300000), `HARVEST_MIN_WSOL_LAMPORTS` (`2000000` — skip closes not worth the
fee), `HARVEST_ACTIVE_FLOOR_LAMPORTS` (`30000000` = 0.03), `HARVEST_SWEEP_CEILING_LAMPORTS`
(`50000000` = 0.05). **Rollback:**
`HARVEST_ENABLED=false` (pure additive, no migration). **Verify:** each tick heartbeats
`send_service_status` — `SELECT ready, beat_at FROM send_service_status WHERE
service='harvest'`. **Read `ready` FIRST, then `beat_at`:** `ready=false` = **disabled**
(the `HARVEST_ENABLED=false` rollback lever, bad thresholds, or an empty roster — its
`beat_at` is written once at boot and then ages, which is expected, NOT a stall);
`ready=true` + **fresh** `beat_at` = running; `ready=true` + **stale** `beat_at` = **stuck**.
(`ready` is NOT per-tick error state — a tick that completes with a few transient
per-wallet errors still heartbeats `ready=true`; those errors stay in the `[send/harvest]`
log.) **When `SENDS_ENABLED≠true` the whole send subsystem is off, so neither harvest nor
confirm beats — the row just ages; that's "sends disabled," not "harvest stuck."** Also:
`[send/harvest]` logs one confirmed close per above-threshold wallet; over hours
`[send/funding] top-up` frequency drops — and each tick records the master balance, so
`SELECT balance_lamports, started_at FROM landing_wallet_balances WHERE
target_name='master' ORDER BY started_at DESC` shows the decline flattening directly.

**Orphan cleanup (manual).** A drained orphan's `send_wallets` row is **not** deleted (the
key is kept in case its stranded USDC dust is ever swept), so harvest keeps spending ~3
read RPCs/tick on it forever. Orphans are rare (only retired targets), so this is
negligible — but if many targets are retired, periodically `DELETE FROM send_wallets WHERE
name = '<target>:<scenario>'` for confirmed-empty drained wallets to stop the probes. Same
manual fix for the one self-perpetuating error case: an orphan that still holds a WSOL ATA
but has < ~5,005 native lamports can't pay the close fee, so it throws and increments the
tick's `errors` (a `[send/harvest] orphan …` log line) every tick — harmless but noisy;
delete the row or hand-fund it a few thousand lamports to let the close land once.

### Confirm poll (in the generator)
Confirmation is a poll loop **inside the generator** (`send/confirm.ts`), not a
separate service — the generator is already the leader-elected singleton, so the
loop rides its leadership. Every ~2s (own guarded `setInterval`, `.catch()`-wrapped
so it never crashes the generator) it reads the in-flight `send_pending` rows and
polls `getSignatureStatuses` (via the generator's `utility` RPC) — no gRPC, the DB
is the registry. It classifies confirmed txs via a single-winner `DELETE …
RETURNING`, reaps rows older than ~80s as not_landed, and heartbeats
`send_service_status(service='confirm')`. The worker send lane **gates** on
`ready=true` + fresh, so it won't dispatch while the generator (hence confirm) is
down. Deploy order: **migration 0002 → generator → workers** (ordering is
convenience; the readiness gate is the guarantee). "Confirm dark" (no landings
stamped) → check `UTILITY_RPC_URL` reachability + that the generator holds the
leader lock.

### Partition / retention
`landing_tx_results` is daily-partitioned by `started_at` and managed by
`partitions.ts` (forward-create + drop): 7d retention (the board reads
`send_rollups`). `send_pending` is unpartitioned and self-draining (rows deleted
on classify/reap; stays <~80s of in-flight sends).
