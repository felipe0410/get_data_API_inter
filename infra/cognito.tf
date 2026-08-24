# ============================================================================
# 🔐 Cognito - Auth M2M para los clientes de la API
# ============================================================================
# Pool DEDICADO a esta API, separado del de go-pos: rotar o revocar las
# credenciales de Inter no toca las facturas, y los scopes describen esta API.
#
# Cada cliente (la web, la app móvil, un script) recibe un App Client con
# client_credentials. El token resultante se manda como Bearer al API Gateway.
# Para agregar uno nuevo: una entrada más en el mapa `clientes`.
# ============================================================================

resource "aws_cognito_user_pool" "inter" {
  provider = aws.main
  name     = "${local.prefix}-${var.env}"

  # No hay login de usuarios, solo M2M
  mfa_configuration = "OFF"

  tags = { Component = "Cognito" }
}

# --- Resource Server (define scopes) ---
resource "aws_cognito_resource_server" "inter" {
  provider     = aws.main
  identifier   = "inter"
  name         = "API Interrapidisimo"
  user_pool_id = aws_cognito_user_pool.inter.id

  scope {
    scope_name        = "consult"
    scope_description = "Consultar datos de guias"
  }

  # Declarado desde ya para no tener que tocar el pool cuando /entregar se
  # migre. Hoy no hay ninguna ruta que lo exija.
  scope {
    scope_name        = "entregar"
    scope_description = "Registrar estado de entrega de guias"
  }
}

# --- Domain (requerido para /oauth2/token) ---
resource "aws_cognito_user_pool_domain" "inter" {
  provider     = aws.main
  domain       = "${local.prefix}-${local.account_id}-${var.env}"
  user_pool_id = aws_cognito_user_pool.inter.id
}

# ============================================================================
# 🏢 App Clients por consumidor (M2M)
# ============================================================================

variable "clientes" {
  description = "Mapa de consumidores de la API: key = id del cliente, value = nombre descriptivo"
  type        = map(string)
  default = {
    "system-delivery-web" = "Web System Delivery"
  }
}

resource "aws_cognito_user_pool_client" "cliente" {
  for_each = var.clientes

  provider     = aws.main
  name         = "${local.prefix}-${each.key}-${var.env}"
  user_pool_id = aws_cognito_user_pool.inter.id

  generate_secret = true

  allowed_oauth_flows                  = ["client_credentials"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["inter/consult"]
  supported_identity_providers         = ["COGNITO"]

  access_token_validity = 1
  token_validity_units {
    access_token = "hours"
  }

  depends_on = [aws_cognito_resource_server.inter]
}

# ============================================================================
# 📤 Outputs
# ============================================================================

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.inter.id
}

output "cognito_token_endpoint" {
  description = "URL para obtener tokens M2M: POST con grant_type=client_credentials"
  value       = "https://${aws_cognito_user_pool_domain.inter.domain}.auth.${local.region}.amazoncognito.com/oauth2/token"
}

output "cliente_client_ids" {
  description = "Client IDs por consumidor (el secret se obtiene desde la consola o la CLI)"
  value       = { for k, v in aws_cognito_user_pool_client.cliente : k => v.id }
}
