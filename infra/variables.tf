variable "aws_region" {
  description = "Región AWS"
  type        = string
  default     = "us-east-1"
}

variable "env" {
  description = "Ambiente: dev, qa, pdn"
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "qa", "pdn"], var.env)
    error_message = "Ambiente no válido. Permitidos: dev, qa, pdn."
  }
}
