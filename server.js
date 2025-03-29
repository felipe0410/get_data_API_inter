const express = require("express");
const app = express();
const port = process.env.PORT || 8080;
const cors = require("cors");

app.use(cors());

app.use(express.json());

app.get("/", (req, res) => res.send("API INTERRAPIDISIMO AQUITANIA"));

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.post("/consult", async (req, res) => {
  console.log("req:::>", req);
  const guias = req.body.guias;
  const password = req.body.password;
  console.log("start getdata");
  if (!guias || !Array.isArray(guias) || guias.length === 0) {
    return res
      .status(400)
      .json({ error: "No se proporcionaron guías válidas" });
  }
  import("./controller/index.mjs")
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
  console.log(`Server running on http://0.0.0.0:${port}`);
});
