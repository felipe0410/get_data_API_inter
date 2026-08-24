# ============================================================================
# 🌐 API Gateway (HTTP API) - API Interrapidísimo
# ============================================================================

resource "aws_apigatewayv2_api" "inter" {
  provider      = aws.main
  name          = "${local.prefix}-api-${var.env}"
  protocol_type = "HTTP"
  description   = "API de consulta de guías de Interrapidísimo"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["POST", "OPTIONS"]
    allow_headers = ["Authorization", "Content-Type"]
    max_age       = 3600
  }

  tags = { Component = "APIGateway" }
}

# --- Cognito JWT Authorizer (acepta tokens de cualquier client del pool) ---
resource "aws_apigatewayv2_authorizer" "cognito" {
  provider         = aws.main
  api_id           = aws_apigatewayv2_api.inter.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito-m2m-authorizer"

  jwt_configuration {
    audience = [for c in aws_cognito_user_pool_client.cliente : c.id]
    issuer   = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.inter.id}"
  }
}

# --- Integration + Ruta Consult ---
resource "aws_apigatewayv2_integration" "lambda_consult" {
  provider               = aws.main
  api_id                 = aws_apigatewayv2_api.inter.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.dispatcher.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "consult" {
  provider  = aws.main
  api_id    = aws_apigatewayv2_api.inter.id
  route_key = "POST /consult"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_consult.id}"

  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  # El token tiene que traer el scope, no solo ser válido. Un client al que se
  # le quite `inter/consult` deja de entrar sin tocar la ruta.
  authorization_scopes = ["inter/consult"]
}

# --- Stage ---
resource "aws_apigatewayv2_stage" "default" {
  provider    = aws.main
  api_id      = aws_apigatewayv2_api.inter.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
      errorMessage   = "$context.error.message"
    })
  }

  tags = { Component = "APIGateway" }
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  provider          = aws.main
  name              = "/aws/apigateway/${local.prefix}-api-${var.env}"
  retention_in_days = 14

  tags = { Component = "CloudWatch" }
}
