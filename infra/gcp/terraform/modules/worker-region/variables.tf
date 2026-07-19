variable "project_id" {
  type = string
}

variable "region" {
  type        = string
  description = "GCP region (e.g. us-east4)."
}

variable "egress_path" {
  type        = string
  description = "Label the worker reports for its egress identity (e.g. gcp-us-east4)."
}

variable "worker_image" {
  type        = string
  description = "Full image URI with tag."
}

variable "worker_sa_email" {
  type        = string
  description = "Service account email the Cloud Run service runs as."
}

variable "secret_keys" {
  type        = set(string)
  description = "Names of secrets to mount as env vars."
}

variable "secret_ids" {
  type        = map(string)
  description = "Map of secret key name to its full Secret Manager resource ID."
}

variable "connector_cidr" {
  type        = string
  description = "CIDR for the Serverless VPC Access connector subnet. Each region has its own VPC, so the same /28 is fine across regions."
  default     = "10.8.0.0/28"
}
