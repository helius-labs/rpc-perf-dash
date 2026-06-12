# GCP workers

Cloud Run hosting for one rpc-perf-dash worker per GCP region. Adds GCP as a
worker_provider alongside AWS, TeraSwitch, and Cloudflare.

## What this deploys

Per region (6 regions: us-east4, us-west1, europe-west3, europe-west2,
asia-northeast1, asia-southeast1):

- Custom VPC + /28 connector subnet
- Reserved static egress IP
- Cloud Router + Cloud NAT bound to the static IP
- Serverless VPC Access connector
- Cloud Run v2 service `rpc-bench-worker` — exactly one instance, CPU always
  allocated, all egress routed through the connector → NAT → static IP

Project-wide (shared by all regions):

- `rpc-bench-worker` service account
- Artifact Registry repo `rpc-bench` (Docker)
- Secret Manager secrets for `NEON_DATABASE_URL_*`, `HELIUS_*`, `TRITON_URL`,
  `ALCHEMY_URL`, `QUICKNODE_URL` (auto-replicated globally)

## Prerequisites

- A GCP project for the workers, with `PROJECT_ID` exported in your shell
  (the build/seed scripts and terraform all take it from there):
  ```bash
  export PROJECT_ID=<your-project-id>
  gcloud auth login
  gcloud config set project "$PROJECT_ID"
  gcloud auth configure-docker us-central1-docker.pkg.dev
  ```
- `terraform` >= 1.5
- `docker` (for the image build) with buildx — needed because Cloud Run runs
  linux/amd64; building on Apple Silicon without `--platform linux/amd64`
  produces images Cloud Run can't schedule.

## First-time rollout

```bash
cd infra/gcp

# 1. Initial terraform apply — creates everything EXCEPT a Cloud Run revision
#    (the worker_image var has no default, so the per-region module fails until
#    you push an image). Pass --target=google_artifact_registry_repository.worker
#    on the first apply to provision just the repo, then run build-image.sh.
cd terraform
terraform init
terraform apply \
  -var=project_id=$PROJECT_ID \
  -target=google_artifact_registry_repository.worker \
  -target=google_artifact_registry_repository_iam_member.worker_pull \
  -target=google_service_account.worker \
  -target=google_secret_manager_secret.worker_secrets \
  -target=google_secret_manager_secret_iam_member.worker_access
cd ..

# 2. Push worker image to Artifact Registry.
./build-image.sh                          # tags with current git short SHA
# Note the URI it prints, e.g.
# us-central1-docker.pkg.dev/<your-project-id>/rpc-bench/worker:8028ea7

# 3. Seed worker secrets. The shared env file is the same one the AWS workers
#    use — see infra/bare-metal/deploy-tsw.sh comments for the expected format.
./seed-secrets.sh /tmp/rpc-bench-worker.env.shared

# 4. Full apply with the image URI from step 2.
cd terraform
terraform apply -var=project_id=$PROJECT_ID -var=worker_image=<uri-from-step-2>
```

After the full apply finishes, the leaderboard will start seeing
`worker_provider=gcp` heartbeats within ~60 seconds.

`terraform output egress_ips` prints the per-region static IPs — share these
with any RPC provider that needs them allow-listed.

## Updating the worker image

```bash
URI=$(./build-image.sh)                   # builds + pushes; prints the URI on stdout
cd terraform
terraform apply -var=project_id=$PROJECT_ID -var=worker_image=$URI
```

`terraform apply` updates each region's Cloud Run service to the new image.
Cloud Run rolls revisions one at a time and waits for the new revision to
pass health checks before cutting traffic.

## Rotating a secret

```bash
./seed-secrets.sh /tmp/new-secrets.env
# Optional: force Cloud Run to pick up the new version immediately (otherwise
# it picks up `latest` on the next service revision).
for region in us-east4 us-west1 europe-west3 europe-west2 asia-northeast1 asia-southeast1; do
  gcloud run services update rpc-bench-worker --region=$region --project=$PROJECT_ID
done
```

## Tear down

```bash
cd terraform
terraform destroy -var=project_id=$PROJECT_ID
```

Note: APIs are NOT disabled on destroy (`disable_on_destroy = false`), so
other resources in the project that depend on those APIs keep working.

## Cost (rough order of magnitude)

Per region (idle): ~$15-25/mo
- Static IP (in use):                  $0.00
- Cloud NAT:                           $1.44/mo + per-GB egress
- Serverless VPC connector (e2-micro): ~$5/mo
- Cloud Run min=1 always-allocated:    ~$10-15/mo

Project-wide:
- Artifact Registry storage: ~$0.10/GB-mo
- Secret Manager:            ~$0.06/secret-mo + per-access (negligible)

Six regions ≈ **$90-150/mo** plus per-GB NAT egress (currently a few cents/mo
at the worker's traffic volume).
