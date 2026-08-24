# ============================================================================
# ⚡ Lambda - Consulta de guías en Interrapidísimo
# ============================================================================
# El código se empaqueta desde lambda/consult/, que scripts/build-lambda.sh
# rellena copiando controller/*.mjs. No hay node_modules: la Lambda usa solo
# `crypto` y el `fetch` global de Node 20.
# ============================================================================

variable "inter_user" {
  description = "Usuario del portal de Interrapidísimo"
  type        = string
  default     = "aquitania.boyaca"
}

variable "max_guias" {
  description = "Tope de guías por request. Existe por el corte de 30s del API Gateway."
  type        = number
  default     = 15
}

variable "inter_delay_ms" {
  description = "Pausa entre consultas de guías, para no gatillar el WAF"
  type        = number
  default     = 500
}

resource "aws_iam_role" "lambda_consult" {
  provider = aws.main
  name     = "${local.prefix}-consult-role-${var.env}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Component = "IAM" }
}

resource "aws_iam_role_policy" "lambda_consult" {
  provider = aws.main
  name     = "ConsultLambdaPolicy"
  role     = aws_iam_role.lambda_consult.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/*"
      }
    ]
  })
}

data "archive_file" "lambda_consult" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/consult"
  output_path = "${path.module}/../lambda/consult.zip"
}

resource "aws_lambda_function" "consult" {
  provider = aws.main
  # 29s: uno menos que el corte duro del API Gateway, para que el error que ve
  # el cliente sea el de la Lambda (con log) y no un 504 opaco de la puerta.
  function_name    = "${local.prefix}-consult-${var.env}"
  role             = aws_iam_role.lambda_consult.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 29
  memory_size      = 512
  filename         = data.archive_file.lambda_consult.output_path
  source_code_hash = data.archive_file.lambda_consult.output_base64sha256

  # La contraseña del portal NO va acá: es del operador y llega en el body de
  # cada request. Meterla como variable de entorno la volvería única y
  # compartida, que es justo lo contrario de como funciona.
  environment {
    variables = {
      INTER_USER     = var.inter_user
      INTER_DELAY_MS = tostring(var.inter_delay_ms)
      MAX_GUIAS      = tostring(var.max_guias)
    }
  }

  tags = { Component = "Lambda" }
}

resource "aws_cloudwatch_log_group" "lambda_consult" {
  provider          = aws.main
  name              = "/aws/lambda/${aws_lambda_function.consult.function_name}"
  retention_in_days = 14

  tags = { Component = "CloudWatch" }
}

resource "aws_lambda_permission" "apigw_invoke_consult" {
  provider      = aws.main
  statement_id  = "AllowAPIGatewayInvokeConsult"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.consult.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.inter.execution_arn}/*/*"
}
