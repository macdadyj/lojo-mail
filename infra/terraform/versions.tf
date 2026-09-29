terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
  }

  # Local state by default so `terraform plan` works on a laptop without a
  # backend bucket. Before the first real apply, create a private state bucket
  # by hand and uncomment the backend below, then `terraform init -migrate-state`.
  # Do not commit *.tfstate.
  #
  # backend "s3" {
  #   bucket       = "lojo-mail-tfstate"
  #   key          = "lojo-mail/terraform.tfstate"
  #   region       = "us-east-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "lojo-mail"
      ManagedBy = "terraform"
      Domain    = var.domain
    }
  }
}
