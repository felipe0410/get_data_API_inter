#!/usr/bin/env bash
# Prepara lambda/consult/ para que Terraform la empaquete.
#
#   vendor/       <- copia de controller/*.mjs (generado, gitignored)
#   node_modules/ <- dependencias (generado, gitignored)
#
# `controller/` es la única fuente de verdad del scraper: la Lambda no tiene
# una copia propia versionada que se pueda desincronizar. Esto corre ANTES de
# cualquier `terraform plan/apply`, porque archive_file lee el directorio al
# planificar, no al aplicar.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAQUETE="$RAIZ/lambda/consult"
VENDOR="$PAQUETE/vendor"

mkdir -p "$VENDOR"
cp "$RAIZ/controller/interClient.mjs" "$VENDOR/interClient.mjs"
cp "$RAIZ/controller/index.mjs"       "$VENDOR/consult.mjs"

# --omit=dev: el zip de la Lambda no necesita nada de desarrollo.
npm ci --omit=dev --prefix "$PAQUETE"

echo "Lambda lista:"
echo "  vendor/       $(ls "$VENDOR" | tr '\n' ' ')"
echo "  node_modules/ $(ls "$PAQUETE/node_modules" | wc -l) paquetes"
