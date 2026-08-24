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
 └──POST /consult  Bearer ──> API Gateway ──JWT──> dispatcher
                                                     ├─ crea jobs_consulta/{jobId}
                                                     ├─ invoca al worker (async)
                                                     └─ 202 {jobId} ──> Web
                                                     ▼
                                                  worker  (hasta 15 min)
                                                    1 login para todo el job
                                                    escribe envios/{guia}
                                                    actualiza jobs_consulta/{jobId}

Web: onSnapshot(jobs_consulta/{jobId}) -> barra de progreso
```

La invocación asíncrona es lo que saca el trabajo de la ventana de 30s del API
Gateway. El dispatcher responde en cuanto encola; nadie espera al worker, así
que si la pestaña se cierra a la mitad el job termina igual.

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

1. **Secrets en GitHub**:
   - `FIREBASE_SA_JSON`: Service Account de Firebase, igual que en go-pos. El
     worker escribe en Firestore, así que sin eso no arranca.
   - `NOTIFY_TOKEN`: secreto compartido con la ruta de WhatsApp de la web
     (`openssl rand -hex 32`). El mismo valor va en el `.env` de la web.

   (El de la contraseña de Inter NO existe: esa viaja en la request.)
2. **Rol OIDC**: el workflow asume `arn:aws:iam::140862068477:role/github-ci-cd`
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
terraform output coleccion_jobs          # colección de progreso en Firestore
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
  -d '{"items":[{"guide":"<numero-de-guia>"}],"password":"<la-del-operador>"}' | jq
# -> 202 {"jobId":"job_...", ...}
# El resultado no viene en la respuesta: mirar jobs_consulta/{jobId} y
# envios/{guia} en Firestore.
```

Un `401` es token ausente o inválido; un `403` suele ser el scope
(`inter/consult`) faltando en el token, que la ruta exige explícitamente.

## Volumen y tiempos

Un job = **un login = una sesión** contra el portal, sin importar cuántas guías
traiga. Ese era el costo de trocear desde la web: ~15s de login por cada lote.

Con ~1,5-2s por guía, 200 guías son 5-7 min: entran en una sola corrida del
worker, que tiene 15 min. Si un job no entra, el worker corta a los
`PRESUPUESTO_MS` (12 min por defecto), se reinvoca con lo que falta y sube
`tramo` en el doc del job. O sea que el techo no es una cantidad de guías sino
cuántos tramos estés dispuesto a esperar. Cada tramo nuevo hace su propio
login, porque es otra invocación y probablemente otro contenedor.

`MAX_GUIAS` (500) es una guarda de cordura para atajar un typo o un bucle, no
un límite técnico.

Para calibrar con datos reales: el campo `msPorGuia` del job trae el promedio
medido, y en CloudWatch está la línea `[worker] job ... completado`.

## WhatsApp

Al terminar cada tramo, el worker le pide a la web que despache los mensajes:

```
POST {WEB_API_BASE}/api/whatsapp/notify-shipments
     x-notify-token: <NOTIFY_TOKEN>
     { shipments: [...], tipo: "oficina" | "domiciliario" }
```

La lógica de plantillas y la API key de Infobip se quedan en la web: no tienen
por qué vivir en dos lados. El worker solo dispara, y así el navegador no
necesita seguir abierto hasta que termine el guardado.

Se notifica **por tramo**, no al final del job: los destinatarios de las
primeras guías reciben el mensaje sin esperar a que termine todo.

Si la notificación falla, **no se cae el job**: las guías ya están en Firestore,
que es lo que importa. El fallo queda en `errores` con `etapa: "whatsapp"` y en
los contadores `whatsappEnviados` / `whatsappFallidos`.

Del lado de la web hay que aplicar `client-snippets/notify-shipments-auth.ts`:
esa ruta hoy es un POST abierto. Y hay que sacar la llamada que hace
`getData/page.tsx` desde el navegador, o cada envío se notificaría dos veces.

## Reintentos

El worker corre con `maximum_retry_attempts = 0`. Por defecto Lambda reintenta
dos veces una invocación asíncrona fallida, y acá eso significaría volver a
consultar guías ya consultadas y reescribir documentos. El estado del job en
Firestore es el registro de lo que pasó; reintentar es decisión de quien lo
mira.

## Lo que NO aplica acá

El modo de respaldo con Playwright (`INTER_MODE=playwright`) **no funciona en
Lambda**: no hay navegadores en el runtime ni espacio razonable para meterlos.
El respaldo vive en el ECS. Si el cliente HTTP se rompe, el plan B es apuntar
la web de vuelta al ECS con `INTER_MODE=playwright` — con la ventana de 30s de
vuelta, o sea troceando desde la web.
