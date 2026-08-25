output "api_gateway_url" {
  description = "URL base del API Gateway"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "consult_endpoint" {
  description = "Endpoint completo de consulta de guías"
  # invoke_url del stage $default ya viene con la barra final. Sin el trimsuffix
  # queda "...amazonaws.com//consult", que no matchea la ruta y da 404.
  value = "${trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")}/consult"
}

output "lambda_dispatcher_name" {
  description = "Lambda que atiende POST /consult y responde 202"
  value       = aws_lambda_function.dispatcher.function_name
}

output "lambda_worker_name" {
  description = "Lambda que consulta las guías y escribe en Firestore"
  value       = aws_lambda_function.worker.function_name
}

output "max_guias_por_job" {
  description = "Tope de guías que acepta el dispatcher en un solo job"
  value       = var.max_guias
}

output "coleccion_jobs" {
  description = "Colección de Firestore donde la web sigue el progreso del job"
  value       = "jobs_consulta"
}
