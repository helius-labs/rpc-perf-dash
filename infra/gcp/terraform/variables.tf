variable "project_id" {
  type        = string
  description = "GCP project hosting the workers. No default — pass -var=project_id=<your-project-id> or set it in a tfvars file."
}

variable "image_location" {
  type        = string
  description = <<-EOT
    Artifact Registry repo location. A single repo serves all worker regions;
    cross-region pulls happen once per deploy, so latency is irrelevant.
  EOT
  default     = "us-central1"
}

variable "worker_image" {
  type        = string
  description = <<-EOT
    Full image URI with tag. Produced by infra/gcp/build-image.sh.
    Example: us-central1-docker.pkg.dev/<your-project-id>/rpc-bench/worker:8028ea7
  EOT
}
