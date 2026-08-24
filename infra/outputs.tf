output "api_gateway_url" {
  description = "URL base del API Gateway"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "consult_endpoint" {
  description = "Endpoint completo de consulta de guías"
  value       = "${aws_apigatewayv2_stage.default.invoke_url}/consult"
}

output "lambda_consult_name" {
  description = "Nombre de la función Lambda de consulta"
  value       = aws_lambda_function.consult.function_name
}

output "max_guias_por_request" {
  description = "Tope de guías por llamada. La web debe trocear en lotes de este tamaño."
  value       = var.max_guias
}
