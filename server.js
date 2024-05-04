const express = require("express");
const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

app.get("/", (req, res) => res.send("API INTERRAPIDISIMO AQUITANIA"));

app.post("/consult", async (req, res) => {
  const guias = req.body.guias;
  console.log("start getdata");
  if (!guias || !Array.isArray(guias) || guias.length === 0) {
    return res
      .status(400)
      .json({ error: "No se proporcionaron guías válidas" });
  }
  import("./index.mjs")
    .then(async (module) => {
      const data = await module.default(guias);
      res.json(data);
    })
    .catch((err) => {
      res.status(500).json({ error: "Error al cargar el módulo.", err });
    });
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
