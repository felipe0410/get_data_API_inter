# ============================================================================
# 🏗️ API Interrapidísimo - Infraestructura Principal
# ============================================================================
# Mismo patrón que go-pos-infra: Terraform con state en S3, Cognito M2M para
# autenticar a los clientes, API Gateway HTTP con authorizer JWT y una Lambda
# por ruta.
# ============================================================================

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # `bucket` se pasa por -backend-config para no acoplar el state a una cuenta.
  # El workflow lo inyecta desde env.STATE_BUCKET; en local:
  #   terraform init -reconfigure -backend-config="bucket=<tfstate-bucket>"
  backend "s3" {
    key    = "dev/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = var.aws_region
  alias  = "main"
}

data "aws_caller_identity" "current" {
  provider = aws.main
}

data "aws_region" "current" {
  provider = aws.main
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  prefix     = "system-delivery-inter"
}
