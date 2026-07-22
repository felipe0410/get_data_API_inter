#!/bin/bash

echo "🚀 Haciendo petición al endpoint /entregar..."

curl -X POST http://localhost:8080/entregar \
  -H "Content-Type: application/json" \
  -d '{
    "guias": ["700179886279"],
    "password": "tu_password_aqui"
  }' \
  --max-time 300 \
  | jq '.'