// ============================================================================
// Lambda /consult — consulta de guías en Interrapidísimo
// ============================================================================
// Envuelve el controlador HTTP que ya usa el servidor Express (controller/
// index.mjs, copiado a lib/consult.mjs por scripts/build-lambda.sh). La forma
// de la respuesta es el mismo array que devuelve `run`, así que la web puede
// consumirla igual que hoy.
//
// Sin dependencias externas: solo `crypto` y el `fetch` global de Node 20.
// ============================================================================
import run from "./lib/consult.mjs";

// API Gateway HTTP API corta a los 30s pase lo que pase, y la Lambda está en
// 29s. El tope de guías es lo que evita que la request muera a mitad de camino
// dejando el trabajo a medias: es preferible un 400 inmediato y que la web
// mande otro lote.
const MAX_GUIAS = Number(process.env.MAX_GUIAS ?? 15);

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** El body llega en base64 cuando el cliente manda un Content-Encoding raro. */
function parseBody(event) {
  if (!event.body) return null;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(raw);
}

export const handler = async (event) => {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return response(400, { error: "body inválido: se esperaba JSON" });
  }
  if (!body) return response(400, { error: "body requerido" });

  const { guias } = body;
  if (!Array.isArray(guias) || guias.length === 0) {
    return response(400, { error: "guias es requerido y debe ser un array no vacío" });
  }
  if (guias.length > MAX_GUIAS) {
    return response(400, {
      error: `demasiadas guías: ${guias.length}. El máximo por request es ${MAX_GUIAS}.`,
      maxGuias: MAX_GUIAS,
      recibidas: guias.length,
    });
  }
  if (guias.some((g) => typeof g !== "string" || !g.trim())) {
    return response(400, { error: "cada guía debe ser un string no vacío" });
  }

  // La contraseña vive en la configuración de la Lambda, no viaja desde el
  // cliente. Se acepta por body solo como puente durante la migración desde
  // el ECS, y queda registrado en el log para poder retirarlo.
  const password = process.env.INTER_PASSWORD || body.password;
  if (!password) {
    return response(500, { error: "INTER_PASSWORD no está configurada" });
  }
  if (!process.env.INTER_PASSWORD) {
    console.warn("Usando la contraseña recibida en el body: configurar INTER_PASSWORD.");
  }

  const inicio = Date.now();
  try {
    const data = await run(guias, password);
    console.log(
      `[consult] ${data.length}/${guias.length} guías en ${Date.now() - inicio}ms`
    );
    return response(200, data);
  } catch (error) {
    console.error("[consult] error:", error);
    return response(502, {
      error: "Error al consultar Interrapidísimo",
      message: error.message,
    });
  }
};
