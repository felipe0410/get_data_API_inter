// ============================================================================
// Dispatcher — lo que atiende POST /consult
// ============================================================================
// Valida, crea el job en Firestore, dispara el worker de forma ASÍNCRONA y
// responde 202 con el jobId. Tiene que terminar en menos de un segundo.
//
// La invocación asíncrona es lo que saca el trabajo de la ventana de 30s del
// API Gateway: la puerta ya respondió y el worker sigue por su cuenta con el
// límite de Lambda, que son 15 minutos por invocación.
// ============================================================================
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { ESTADOS, FieldValue, jobRef } from "./firestore.mjs";

const lambda = new LambdaClient({});
const WORKER = process.env.WORKER_FUNCTION_NAME;

// Tope por job. No sale de los 30s (ya no aplican) sino de acotar el trabajo a
// algo que el worker pueda terminar encadenando tramos en un tiempo razonable.
const MAX_GUIAS = Number(process.env.MAX_GUIAS ?? 500);

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return null;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(raw);
}

/** Deja solo los campos del formulario que el worker va a mergear. */
function normalizarItem(item) {
  if (typeof item === "string") return { guide: item.trim() };
  if (!item || typeof item !== "object") return null;
  const guide = String(item.guide ?? "").trim();
  if (!guide) return null;
  return {
    guide,
    valor: item.valor ?? null,
    box: item.box ?? null,
    packageNumber: item.packageNumber ?? null,
    revision: item.revision ?? null,
    pago: item.pago ?? null,
    shippingCost: item.shippingCost ?? null,
  };
}

export const handler = async (event) => {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return response(400, { error: "body inválido: se esperaba JSON" });
  }
  if (!body) return response(400, { error: "body requerido" });

  // `items` es la forma nueva (con los extras del formulario). Se acepta
  // `guias: string[]` para no romper a quien todavía llame como el ECS.
  const crudos = Array.isArray(body.items) ? body.items : body.guias;
  if (!Array.isArray(crudos) || crudos.length === 0) {
    return response(400, {
      error: "items (o guias) es requerido y debe ser un array no vacío",
    });
  }
  if (crudos.length > MAX_GUIAS) {
    return response(400, {
      error: `demasiadas guías: ${crudos.length}. El máximo por job es ${MAX_GUIAS}.`,
      maxGuias: MAX_GUIAS,
      recibidas: crudos.length,
    });
  }

  const items = crudos.map(normalizarItem);
  if (items.some((i) => i === null)) {
    return response(400, { error: "cada item debe traer un `guide` no vacío" });
  }

  // Guías repetidas escribirían dos veces el mismo doc y gastarían el doble de
  // tiempo contra el portal, que es el recurso escaso acá.
  const vistas = new Set();
  const unicas = items.filter((i) => {
    if (vistas.has(i.guide)) return false;
    vistas.add(i.guide);
    return true;
  });

  const { password } = body;
  if (typeof password !== "string" || !password) {
    return response(400, { error: "password es requerido" });
  }

  // Sin esto el SDK falla con un error críptico sobre el nombre de función, y
  // encima despues de haber creado el job: mejor cortar antes y decir qué falta.
  if (!WORKER) {
    console.error("[dispatcher] WORKER_FUNCTION_NAME no está configurada");
    return response(500, { error: "WORKER_FUNCTION_NAME no está configurada" });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const domiciliary = body.domiciliary === true;

  // El job se crea ACÁ y no en el worker para que la web tenga algo a lo que
  // suscribirse en cuanto recibe el 202, sin una ventana en que el doc no
  // existe todavía.
  await jobRef(jobId).set({
    jobId,
    estado: ESTADOS.ENCOLADO,
    domiciliary,
    total: unicas.length,
    procesadas: 0,
    guardadas: 0,
    sinDatos: 0,
    errores: [],
    tramo: 0,
    msPorGuia: null,
    creadoEn: FieldValue.serverTimestamp(),
    actualizadoEn: FieldValue.serverTimestamp(),
  });

  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: WORKER,
        InvocationType: "Event", // asíncrono: no espera al worker
        Payload: Buffer.from(
          JSON.stringify({ jobId, items: unicas, password, domiciliary, tramo: 0 })
        ),
      })
    );
  } catch (error) {
    console.error("[dispatcher] no se pudo invocar al worker:", error);
    await jobRef(jobId).update({
      estado: ESTADOS.ERROR,
      errores: [{ etapa: "dispatch", message: error.message }],
      actualizadoEn: FieldValue.serverTimestamp(),
    });
    return response(502, { error: "No se pudo encolar el trabajo", jobId });
  }

  console.log(`[dispatcher] job ${jobId} encolado con ${unicas.length} guías`);
  return response(202, {
    jobId,
    total: unicas.length,
    duplicadasDescartadas: items.length - unicas.length,
    coleccionJob: "jobs_consulta",
  });
};
