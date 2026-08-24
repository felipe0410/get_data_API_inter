# Infra — API de consulta de guías (Lambda + API Gateway + Cognito)

Mismo patrón que `go-pos-infra`, aplicado a `/consult`. `/entregar` sigue solo
en el ECS por ahora; migrarlo es agregar una Lambda y una ruta más.

- **Cuenta / región**: `140862068477` / `us-east-1`
- **Cognito**: pool DEDICADO (`system-delivery-inter-dev`), separado del de go-pos
- **State**: `s3://system-delivery-inter-tfstate-140862068477/dev/terraform.tfstate`

```
Web ──POST /api/inter-token──> Next.js (server) ──> Cognito /oauth2/token
 │                                                        │
 │  <──────────────── access_token (scope inter/consult) ─┘
 │
 └──POST /consult  Authorization: Bearer ──> API Gateway ──JWT authorizer──>
                                                 Lambda ──HTTP──> Interrapidísimo
```

## La contraseña del portal

Es del operador y **viaja en el body de cada request**, junto con las guías.
No es configuración del despliegue: no hay `INTER_PASSWORD` ni en la Lambda ni
en los secrets del repo, y el workflow no necesita ninguno.

```json
{ "guias": ["105600", "105601"], "password": "<la del operador>" }
```

Lo único fijo es `INTER_USER` (`aquitania.boyaca` por defecto), que sí es
variable de entorno de la Lambda.

El caché de sesión de `interClient.mjs` está indexado por usuario **y** hash de
la contraseña, justamente porque esta es dinámica: si estuviera indexado solo
por usuario, una request con la contraseña equivocada reutilizaría el token de
un login anterior correcto.

## Antes del primer deploy

1. **Rol OIDC**: el workflow asume `arn:aws:iam::140862068477:role/github-ci-cd`
   (el mismo de go-pos). Necesita permisos para Lambda, API Gateway, Cognito,
   IAM, CloudWatch Logs y el bucket de state. Si el rol quedó acotado a los
   recursos de go-pos, hay que ampliarlo. Es el único requisito previo.

## Deploy

Automático: push a `main` que toque `infra/`, `lambda/`, `controller/` o el
script de build. En PR solo corre el `plan` y lo comenta.

Manual desde local (requiere credenciales AWS):

```bash
./scripts/build-lambda.sh          # SIEMPRE antes de terraform
cd infra
terraform init -reconfigure \
  -backend-config="bucket=system-delivery-inter-tfstate-140862068477"
terraform plan -var="env=dev"
```

> `scripts/build-lambda.sh` copia `controller/interClient.mjs` y
> `controller/index.mjs` a `lambda/consult/lib/`. `archive_file` lee ese
> directorio en el **plan**, no en el apply, así que si no se corre antes el
> zip sale incompleto. `lambda/consult/lib/` está en `.gitignore` a propósito:
> la fuente de verdad es `controller/`, y una copia versionada se desincroniza
> sin que nadie se entere.

## Después del apply

```bash
terraform output consult_endpoint        # URL para la web
terraform output cognito_token_endpoint  # URL del token
terraform output cliente_client_ids      # client_id por consumidor
```

El `client_secret` no sale por output (Terraform lo dejaría en el state en
claro). Se saca con la CLI:

```bash
aws cognito-idp describe-user-pool-client \
  --user-pool-id "$(terraform output -raw cognito_user_pool_id)" \
  --client-id "$(terraform output -json cliente_client_ids | jq -r '."system-delivery-web"')" \
  --query 'UserPoolClient.ClientSecret' --output text
```

## Probar sin la web

```bash
TOKEN=$(curl -s -X POST "$(terraform output -raw cognito_token_endpoint)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=client_credentials&scope=inter/consult" | jq -r .access_token)

curl -s -X POST "$(terraform output -raw consult_endpoint)" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"guias":["<numero-de-guia>"],"password":"<la-del-operador>"}' | jq
```

Un `401` es token ausente o inválido; un `403` suele ser el scope
(`inter/consult`) faltando en el token, que la ruta exige explícitamente.

## El tope de guías

`MAX_GUIAS` (default **15**) sale de que el API Gateway HTTP corta a los 30s y
la Lambda consulta las guías en serie con `INTER_DELAY_MS` de pausa entre cada
una. Pasado el tope, la Lambda responde `400` de inmediato en vez de morir a
mitad de camino. La web trocea en lotes (ver `client-snippets/interApi.ts`).

Para calibrarlo con datos reales, mirar en CloudWatch la línea
`[consult] N/M guías en Xms` y ajustar `-var="max_guias=..."`. Si el número
real que se necesita no entra en 30s, ahí sí toca la versión asíncrona con
cola.

## Lo que NO aplica acá

El modo de respaldo con Playwright (`INTER_MODE=playwright`) **no funciona en
Lambda**: no hay navegadores en el runtime ni espacio razonable para meterlos.
El respaldo vive en el ECS. Si el cliente HTTP se rompe, el plan B es apuntar
la web de vuelta al ECS con `INTER_MODE=playwright`.
