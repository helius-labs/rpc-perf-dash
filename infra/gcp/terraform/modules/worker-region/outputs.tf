output "egress_ip" {
  description = "Static IP every outbound packet leaves on for this region."
  value       = google_compute_address.egress.address
}

output "service_url" {
  description = "Cloud Run service URL — auth-required, not public."
  value       = google_cloud_run_v2_service.worker.uri
}
