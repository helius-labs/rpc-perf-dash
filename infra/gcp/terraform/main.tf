provider "google" {
  project = var.project_id
}

locals {
  # Worker regions. Key is the GCP region (must match an entry in
  # packages/shared/src/types.ts:GEO_REGION_MAP.gcp). Value is the
  # egress_path label the worker reports to the leaderboard.
  regions = {
    "us-east4"        = "gcp-us-east4"
    "us-west1"        = "gcp-us-west1"
    "europe-west3"    = "gcp-europe-west3"
    "europe-west2"    = "gcp-europe-west2"
    "asia-northeast1" = "gcp-asia-northeast1"
    "asia-southeast1" = "gcp-asia-southeast1"
  }

  # Secrets the worker reads as env vars. Mirrors NEON_WORKER_SECRET_KEYS +
  # PANEL_SECRET_KEYS in infra/cdk/lib/worker-stack.ts so the same
  # source-of-truth env file can seed both clouds. Workers open a pooled
  # connection only, so the direct (unpooled) Neon URL is intentionally absent.
  secret_keys = toset([
    "NEON_DATABASE_URL_POOLED",
    "HELIUS_URL",
    "TRITON_URL",
    "ALCHEMY_URL",
    "QUICKNODE_URL",
  ])

  required_apis = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "vpcaccess.googleapis.com",
    "secretmanager.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
  ])
}

# Enable required APIs. disable_on_destroy=false so `terraform destroy` doesn't
# strand other GCP resources in this project that share the same APIs.
resource "google_project_service" "apis" {
  for_each           = local.required_apis
  service            = each.key
  disable_on_destroy = false
}

# Worker service account — one identity shared across all regions. Each
# region's Cloud Run service runs as this SA and reads secrets via
# roles/secretmanager.secretAccessor (granted per-secret below).
resource "google_service_account" "worker" {
  account_id   = "rpc-bench-worker"
  display_name = "rpc-perf-dash worker"
  depends_on   = [google_project_service.apis]
}

# Artifact Registry — one Docker repo, all worker regions pull from here.
# Cross-region pull happens on deploy (cold start) and is cached locally.
resource "google_artifact_registry_repository" "worker" {
  location      = var.image_location
  repository_id = "rpc-bench"
  format        = "DOCKER"
  description   = "rpc-perf-dash worker images"
  depends_on    = [google_project_service.apis]
}

# Allow the worker SA to pull images from the repo.
resource "google_artifact_registry_repository_iam_member" "worker_pull" {
  location   = google_artifact_registry_repository.worker.location
  repository = google_artifact_registry_repository.worker.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.worker.email}"
}

# Secrets — globally replicated, accessed by all regions.
resource "google_secret_manager_secret" "worker_secrets" {
  for_each  = local.secret_keys
  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

# Grant the worker SA access to each secret.
resource "google_secret_manager_secret_iam_member" "worker_access" {
  for_each  = local.secret_keys
  secret_id = google_secret_manager_secret.worker_secrets[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

# Per-region worker stack.
module "worker_region" {
  for_each = local.regions

  source = "./modules/worker-region"

  project_id      = var.project_id
  region          = each.key
  egress_path     = each.value
  worker_image    = var.worker_image
  worker_sa_email = google_service_account.worker.email
  secret_keys     = local.secret_keys
  secret_ids      = { for k, v in google_secret_manager_secret.worker_secrets : k => v.id }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_iam_member.worker_access,
    google_artifact_registry_repository_iam_member.worker_pull,
  ]
}
