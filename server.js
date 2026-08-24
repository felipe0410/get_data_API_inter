const express = require("express");
const app = express();
const port = process.env.PORT || 8080;
const cors = require("cors");

app.use(cors());

app.use(express.json());

// Modo de scraping. "http" (por defecto) usa el cliente HTTP puro; "playwright"
// vuelve a la implementación con navegador que quedó archivada en
// controller/legacy/ como respaldo. Se cambia con la variable de entorno
// INTER_MODE, sin tocar código: INTER_MODE=playwright npm start
const MODOS_VALIDOS = ["http", "playwright"];
const modoPedido = (process.env.INTER_MODE || "http").toLowerCase();
if (!MODOS_VALIDOS.includes(modoPedido)) {
  console.warn(
    `INTER_MODE="${modoPedido}" no es válido (${MODOS_VALIDOS.join("|")}). Usando "http".`
  );
}
const INTER_MODE = MODOS_VALIDOS.includes(modoPedido) ? modoPedido : "http";

const CONTROLLERS = {
  consult: {
    http: "./controller/index.mjs",
    playwright: "./controller/legacy/index.playwright.mjs",
  },
  entregar: {
    http: "./controller/entrega.mjs",
    playwright: "./controller/legacy/entrega.playwright.mjs",
  },
};

/** Devuelve la ruta del controlador según INTER_MODE, con fallback a http. */
function controllerFor(accion) {
  const rutas = CONTROLLERS[accion];
  return rutas[INTER_MODE] || rutas.http;
}

app.get("/", (req, res) => res.send("API INTERRAPIDISIMO AQUITANIA"));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", mode: INTER_MODE });
});

app.post("/consult", async (req, res) => {
  const guias = req.body.guias;
  const password = req.body.password;
  console.log("start getdata");
  if (!guias || !Array.isArray(guias) || guias.length === 0) {
    return res
      .status(400)
      .json({ error: "No se proporcionaron guías válidas" });
  }
  import(controllerFor("consult"))
    .then(async (module) => {
      const data = await module.default(guias, password);
      res.json(data);
    })
    .catch((err) => {
      console.error(err);
      res.status(500).json({
        error: "Error al procesar la solicitud",
        message: err.message || "Unknown error",
        stack: err.stack,
      });
    });
});

app.post("/entregar", async (req, res) => {
  const guias = req.body.guias;
  const password = req.body.password;
  console.log("start getdata entregar");
  if (!guias || !Array.isArray(guias) || guias.length === 0) {
    return res
      .status(400)
      .json({ error: "No se proporcionaron guías válidas" });
  }
  import(controllerFor("entregar"))
    .then(async (module) => {
      const data = await module.default(guias, password);
      res.json(data);
    })
    .catch((err) => {
      console.error(err);
      res.status(500).json({
        error: "Error al procesar la solicitud",
        message: err.message || "Unknown error",
        stack: err.stack,
      });
    });
});

app.post("/whatsapp", async (req, res) => {
  const guias = req.body.guias;
  const password = req.body.password;
  console.log("start getdata whatsaap");
  import("./controller/whatsapp.mjs")
    .then(async (module) => {
      const data = await module.default();
      res.json(data);
    })
    .catch((err) => {
      console.error(err);
      res.status(500).json({
        error: "Error al procesar la solicitud",
        message: err.message || "Unknown error",
        stack: err.stack,
      });
    });
});

app.use(
  cors({
    origin: "*",
  })
);

app.listen(port, () => {
  console.log(`Server running on http://0.0.0.0:${port} (modo: ${INTER_MODE})`);
});