terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
    }
  }
}

# Custom VPC per region — keeps egress paths isolated and lets each region's
# Cloud NAT bind to its own static IP without cross-region routing.
resource "google_compute_network" "vpc" {
  name                    = "rpc-bench-${var.region}"
  auto_create_subnetworks = false
}

# Subnet for the Serverless VPC Access connector. /28 (16 IPs) is the minimum
# the connector accepts.
resource "google_compute_subnetwork" "connector" {
  name          = "rpc-bench-conn-${var.region}"
  region        = var.region
  network       = google_compute_network.vpc.id
  ip_cidr_range = var.connector_cidr
}

# Static egress IP — the deterministic outbound address used by every request
# the worker sends. This is what we report as the worker's egress identity
# (and what RPC providers see in their access logs).
resource "google_compute_address" "egress" {
  name   = "rpc-bench-egress-${var.region}"
  region = var.region
}

# Cloud Router → Cloud NAT → static egress IP. All connector-routed traffic
# leaves through the reserved address above.
resource "google_compute_router" "router" {
  name    = "rpc-bench-router-${var.region}"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "rpc-bench-nat-${var.region}"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.egress.self_link]
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = false
    filter = "ERRORS_ONLY"
  }
}

# Serverless VPC Access connector — Cloud Run egresses through this into the
# VPC, then out via Cloud NAT.
resource "google_vpc_access_connector" "connector" {
  name          = "rpc-bench-${var.region}"
  region        = var.region
  machine_type  = "e2-micro"
  min_instances = 2
  max_instances = 3

  subnet {
    name = google_compute_subnetwork.connector.name
  }
}

# Cloud Run worker. Pinned at exactly one instance with CPU always allocated
# so persistent connections to RPC providers and the heartbeat loop survive
# between requests.
resource "google_cloud_run_v2_service" "worker" {
  name     = "rpc-bench-worker"
  location = var.region

  # Deletion protection off so `terraform destroy` works without flipping
  # the flag manually. Re-enable if/when this lands in production-critical
  # state.
  deletion_protection = false

  template {
    service_account = var.worker_sa_email

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      # ALL_TRAFFIC sends every outbound packet through the connector → NAT,
      # so the static egress IP applies to RPC calls as well as DB writes.
      egress = "ALL_TRAFFIC"
    }

    containers {
      image = var.worker_image

      resources {
        # cpu_idle=false ("CPU always allocated") is required for our
        # background heartbeat / persistent connections to keep running
        # between HTTP requests. Without this Cloud Run throttles CPU
        # when no request is in flight.
        cpu_idle          = false
        startup_cpu_boost = true

        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      ports {
        container_port = 8080
      }

      env {
        name  = "WORKER_PROVIDER"
        value = "gcp"
      }
      env {
        name  = "WORKER_REGION"
        value = var.region
      }
      env {
        name  = "WORKER_EGRESS_PATH"
        value = var.egress_path
      }
      env {
        # Cloud Run hostnames every container as "localhost", so the worker's
        # default WORKER_ID = `${hostname()}-${pid}` collides across all 6
        # regions and they thrash a single worker_heartbeat row. Set
        # explicitly so each region has its own identity.
        name  = "WORKER_ID"
        value = var.egress_path
      }
      # PORT is reserved by Cloud Run — it sets it automatically based on
      # ports.container_port. Don't declare it.

      dynamic "env" {
        for_each = var.secret_keys
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = var.secret_ids[env.value]
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        # The early-bind HTTP listener (apps/worker/src/early-bind.ts) binds
        # 0.0.0.0:8080 before the first sample, so the probe should pass
        # within ~1-2s of container start. Generous failure budget gives
        # the worker time to install deps on first boot.
        tcp_socket {
          port = 8080
        }
        initial_delay_seconds = 1
        period_seconds        = 5
        timeout_seconds       = 3
        failure_threshold     = 10
      }

      liveness_probe {
        http_get {
          path = "/"
        }
        initial_delay_seconds = 30
        period_seconds        = 60
        timeout_seconds       = 5
        failure_threshold     = 3
      }
    }

    # 10-minute request timeout. Worker handles requests internally with
    # its own polling loop, so this only matters for the health probes.
    timeout = "600s"
  }

  # Cloud Run doesn't expose the service publicly unless we add an
  # all-users invoker binding. We don't need public access — the worker
  # talks outbound only. Skip the IAM binding so /healthz is reachable
  # only from authenticated tooling (gcloud, this terraform).
}
