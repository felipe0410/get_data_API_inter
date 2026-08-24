# Respaldo: implementación con Playwright

Estos archivos son la versión anterior de los controladores, la que consultaba
Interrapidísimo abriendo un navegador con Playwright. Se conservan como plan B
por si el cliente HTTP puro (`controller/interClient.mjs`) deja de funcionar
—porque cambie el sitio, el cifrado del login o el WAF—.

| Archivo                   | Reemplaza a              | Endpoint    |
| ------------------------- | ------------------------ | ----------- |
| `index.playwright.mjs`    | `controller/index.mjs`   | `/consult`  |
| `entrega.playwright.mjs`  | `controller/entrega.mjs` | `/entregar` |

Ambos mantienen la firma `run(guias, password)` y la misma forma de salida que
los controladores HTTP, así que son intercambiables sin tocar el resto.

## Cómo activarlos

No hay que editar código. Se levanta el servidor con la variable de entorno:

```bash
INTER_MODE=playwright npm start
```

Sin la variable, o con `INTER_MODE=http`, se usa el cliente HTTP (por defecto).
Para confirmar qué modo está corriendo:

```bash
curl localhost:8080/health
# {"status":"OK","mode":"http"}
```

En el deploy (ECR / Cloud Run / donde corra el contenedor) se define la misma
variable en la configuración del servicio y se reinicia.

## Requisitos del modo Playwright

- El paquete `playwright` tiene que estar instalado. Hoy llega de forma
  transitiva por `@playwright/test` (devDependency), así que un `npm ci` con
  `NODE_ENV=production` lo dejaría afuera. Si eso pasa: `npm i playwright`.
- Los navegadores tienen que estar en la imagen. El `Dockerfile` ya corre
  `npx playwright install --with-deps`.

## Diferencia respecto al original

El original lanzaba el navegador con `headless: false`, lo que en un contenedor
sin display falla. Acá quedó configurable y **headless por defecto**:

```js
headless: process.env.PLAYWRIGHT_HEADLESS !== "false"
```

Para depurar en local viendo el navegador:

```bash
INTER_MODE=playwright PLAYWRIGHT_HEADLESS=false npm start
```

Fuera de ese cambio, el código es idéntico al del commit `3b0a3df`, el último
que tuvo la implementación con navegador en su ubicación original.
