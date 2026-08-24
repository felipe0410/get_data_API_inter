#!/usr/bin/env bash
# Sincroniza el código del controlador a la carpeta que Terraform empaqueta.
#
# `controller/` es la única fuente de verdad: la Lambda no tiene una copia
# propia que se pueda desincronizar. Este script la refresca antes de cada
# `terraform plan/apply`, y `lambda/consult/lib/` está en .gitignore.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINO="$RAIZ/lambda/consult/lib"

mkdir -p "$DESTINO"
cp "$RAIZ/controller/interClient.mjs" "$DESTINO/interClient.mjs"
cp "$RAIZ/controller/index.mjs"       "$DESTINO/consult.mjs"

echo "Lambda lista: $(cd "$RAIZ" && ls lambda/consult/lib)"
