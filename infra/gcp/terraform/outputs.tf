output "egress_ips" {
  description = "Per-region static egress IP — the deterministic outbound address each worker sends RPC requests from. Share with providers if they need to allow-list."
  value       = { for k, m in module.worker_region : k => m.egress_ip }
}

output "service_urls" {
  description = "Cloud Run service URLs per region. Hit /healthz from a browser to confirm a worker is up."
  value       = { for k, m in module.worker_region : k => m.service_url }
}

output "artifact_repo" {
  description = "Artifact Registry repo URI — pass to infra/gcp/build-image.sh as the push target."
  value       = "${google_artifact_registry_repository.worker.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.worker.repository_id}"
}
