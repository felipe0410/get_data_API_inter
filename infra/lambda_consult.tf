# ============================================================================
# ⚡ Lambdas - Consulta de guías (dispatcher + worker)
# ============================================================================
# Dos funciones sobre EL MISMO zip, cambiando solo el handler:
#
#   dispatcher  atiende POST /consult, crea el job, invoca al worker y
#               responde 202. Vive dentro de la ventana del API Gateway.
#   worker      corre asíncrono, sin nadie esperándolo, y escribe en Firestore.
#               Ahí es donde el trabajo puede durar minutos.
#
# El paquete lo arma scripts/build-lambda.sh (vendor/ + node_modules).
# ============================================================================

variable "inter_user" {
  description = "Usuario del portal de Interrapidísimo"
  type        = string
  default     = "aquitania.boyaca"
}

variable "firebase_sa_json" {
  description = "Service Account JSON de Firebase (inyectado desde GitHub Secrets)"
  type        = string
  sensitive   = true
}

variable "max_guias" {
  description = "Tope de guías por job que acepta el dispatcher"
  type        = number
  default     = 500
}

variable "inter_delay_ms" {
  description = "Pausa entre consultas de guías, para no gatillar el WAF"
  type        = number
  default     = 500
}

variable "web_api_base" {
  description = "Base de la web. El worker le pide que despache los WhatsApp."
  type        = string
  default     = "https://systemdelivery-e610d.web.app"
}

variable "notify_token" {
  description = "Secreto compartido con /api/whatsapp/notify-shipments"
  type        = string
  sensitive   = true
  default     = ""
}

variable "presupuesto_ms" {
  description = "Tiempo que trabaja un tramo antes de encadenar el siguiente"
  type        = number
  default     = 720000 # 12 min de los 15 que da Lambda
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
      },
      {
        # El dispatcher invoca al worker, y el worker se invoca a sí mismo para
        # encadenar tramos cuando un job no entra en una sola corrida.
        Sid    = "InvokeWorker"
        Effect = "Allow"
        Action = "lambda:InvokeFunction"
        Resource = [
          "arn:aws:lambda:${local.region}:${local.account_id}:function:${local.prefix}-worker-${var.env}"
        ]
      }
    ]
  })
}

data "archive_file" "lambda_consult" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/consult"
  output_path = "${path.module}/../lambda/consult.zip"
}

locals {
  lambda_env_comun = {
    INTER_USER       = var.inter_user
    INTER_DELAY_MS   = tostring(var.inter_delay_ms)
    MAX_GUIAS        = tostring(var.max_guias)
    FIREBASE_SA_JSON = var.firebase_sa_json
  }
}

# --- Dispatcher: responde el 202 ---------------------------------------------
resource "aws_lambda_function" "dispatcher" {
  provider         = aws.main
  function_name    = "${local.prefix}-dispatcher-${var.env}"
  role             = aws_iam_role.lambda_consult.arn
  handler          = "dispatcher.handler"
  runtime          = "nodejs20.x"
  timeout          = 15
  memory_size      = 512
  filename         = data.archive_file.lambda_consult.output_path
  source_code_hash = data.archive_file.lambda_consult.output_base64sha256

  environment {
    variables = merge(local.lambda_env_comun, {
      WORKER_FUNCTION_NAME = "${local.prefix}-worker-${var.env}"
    })
  }

  tags = { Component = "Lambda" }
}

# --- Worker: el trabajo largo ------------------------------------------------
resource "aws_lambda_function" "worker" {
  provider = aws.main
  # 15 min es el techo de Lambda. El worker corta a los 12 (presupuesto_ms) y
  # encadena otro tramo, así que el techo real del job es la paciencia, no esto.
  function_name    = "${local.prefix}-worker-${var.env}"
  role             = aws_iam_role.lambda_consult.arn
  handler          = "worker.handler"
  runtime          = "nodejs20.x"
  timeout          = 900
  memory_size      = 1024
  filename         = data.archive_file.lambda_consult.output_path
  source_code_hash = data.archive_file.lambda_consult.output_base64sha256

  environment {
    variables = merge(local.lambda_env_comun, {
      PRESUPUESTO_MS = tostring(var.presupuesto_ms)
      WEB_API_BASE   = var.web_api_base
      NOTIFY_TOKEN   = var.notify_token
    })
  }

  tags = { Component = "Lambda" }
}

# Sin reintentos automáticos. Por defecto Lambda reintenta 2 veces una
# invocación asíncrona que falla, y acá eso significaría volver a consultar
# guías ya consultadas y reescribir documentos. El estado del job en Firestore
# es el registro de lo que pasó; reintentar es decisión de quien lo mira.
resource "aws_lambda_function_event_invoke_config" "worker" {
  provider                     = aws.main
  function_name                = aws_lambda_function.worker.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 3600
}

resource "aws_cloudwatch_log_group" "lambda_dispatcher" {
  provider          = aws.main
  name              = "/aws/lambda/${aws_lambda_function.dispatcher.function_name}"
  retention_in_days = 14

  tags = { Component = "CloudWatch" }
}

resource "aws_cloudwatch_log_group" "lambda_worker" {
  provider          = aws.main
  name              = "/aws/lambda/${aws_lambda_function.worker.function_name}"
  retention_in_days = 14

  tags = { Component = "CloudWatch" }
}

resource "aws_lambda_permission" "apigw_invoke_dispatcher" {
  provider      = aws.main
  statement_id  = "AllowAPIGatewayInvokeDispatcher"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dispatcher.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.inter.execution_arn}/*/*"
}
