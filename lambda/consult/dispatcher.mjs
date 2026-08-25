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
import { db, ESTADOS, FieldValue, jobRef, procesadosRef } from "./firestore.mjs";

const lambda = new LambdaClient({});
const WORKER = process.env.WORKER_FUNCTION_NAME;

// Tope por job. No sale de los 30s (ya no aplican) sino de acotar el trabajo a
// algo que el worker pueda terminar encadenando tramos en un tiempo razonable.
const MAX_GUIAS = Number(process.env.MAX_GUIAS ?? 500);

/** La misma fecha que usa la web para nombrar el doc de guardado_rapido. */
function hoyColombia() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

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

  const { password } = body;
  if (typeof password !== "string" || !password) {
    return response(400, { error: "password es requerido" });
  }

  // Forma nueva: la web manda solo {fecha, tipo} y la Lambda va a buscar los
  // paquetes a guardado_rapido. Evita mandar 200 objetos por la red y deja el
  // dedup de un solo lado.
  //
  // Se siguen aceptando `items` y `guias` explícitos: es lo que usan las
  // pruebas y cualquier cliente viejo.
  const tipo = body.tipo === "domiciliario" ? "domiciliario" : "oficina";
  const fecha = typeof body.fecha === "string" && body.fecha ? body.fecha : hoyColombia();

  let crudos = Array.isArray(body.items) ? body.items : body.guias;
  if (!Array.isArray(crudos)) {
    try {
      const snap = await db
        .collection("guardado_rapido")
        .doc(fecha)
        .collection(tipo)
        .get();
      crudos = snap.docs.map((d) => ({ guide: d.id, ...d.data() }));
    } catch (error) {
      console.error("[dispatcher] no se pudo leer guardado_rapido:", error);
      return response(502, { error: "No se pudo leer el guardado rápido" });
    }
  }
  if (crudos.length === 0) {
    return response(400, {
      error: `No hay paquetes de '${tipo}' en el guardado rápido del ${fecha}`,
      fecha,
      tipo,
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
  let pendientes = items.filter((i) => {
    if (vistas.has(i.guide)) return false;
    vistas.add(i.guide);
    return true;
  });

  // Sin esto el SDK falla con un error críptico sobre el nombre de función, y
  // encima despues de haber creado el job: mejor cortar antes y decir qué falta.
  if (!WORKER) {
    console.error("[dispatcher] WORKER_FUNCTION_NAME no está configurada");
    return response(500, { error: "WORKER_FUNCTION_NAME no está configurada" });
  }

  // Dedup contra lo ya consultado hoy. Va acá y no en el worker para que la
  // respuesta sea honesta desde el primer segundo: el operador ve "60 ya
  // estaban, encolo 38" en vez de un total que después no cuadra.
  //
  // Una guía entra a esa lista solo si se guardó bien (lo hace el worker), así
  // que volver a apretar el botón reintenta exactamente las que fallaron.
  let yaProcesadas = 0;
  const forzar = body.forzar === true;
  if (!forzar) {
    try {
      const doc = await procesadosRef(fecha).get();
      const hechas = new Set(doc.exists ? doc.data()[tipo] ?? [] : []);
      const antes = pendientes.length;
      pendientes = pendientes.filter((i) => !hechas.has(i.guide));
      yaProcesadas = antes - pendientes.length;
    } catch (error) {
      // Si no se puede leer el registro, se procesa todo: repetir una consulta
      // es molesto, perder guías no.
      console.warn("[dispatcher] no se pudo leer envios_procesados:", error.message);
    }
  }

  if (pendientes.length === 0) {
    return response(200, {
      jobId: null,
      fecha,
      tipo,
      recibidas: items.length,
      yaProcesadas,
      total: 0,
      mensaje: "No hay guías nuevas para consultar",
    });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const domiciliary = tipo === "domiciliario";
  // Modo prueba: escribe en envios_prueba y no manda WhatsApp. Sirve para
  // correr guías reales contra el portal sin tocar producción ni avisarle a
  // nadie, y poder comparar el resultado con lo que ya hay en envios.
  const modoPrueba = body.modoPrueba === true;

  // El job se crea ACÁ y no en el worker para que la web tenga algo a lo que
  // suscribirse en cuanto recibe el 202, sin una ventana en que el doc no
  // existe todavía.
  await jobRef(jobId).set({
    jobId,
    fecha,
    tipo,
    estado: ESTADOS.ENCOLADO,
    domiciliary,
    modoPrueba,
    total: pendientes.length,
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
          JSON.stringify({ jobId, items: pendientes, password, domiciliary, modoPrueba, fecha, tipo, tramo: 0 })
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

  console.log(`[dispatcher] job ${jobId}: ${pendientes.length} guías (${yaProcesadas} ya estaban) de ${fecha}/${tipo}`);
  return response(202, {
    jobId,
    fecha,
    tipo,
    recibidas: items.length,
    yaProcesadas,
    modoPrueba,
    coleccionDestino: modoPrueba ? "envios_prueba" : "envios",
    total: pendientes.length,
    duplicadasDescartadas: items.length - pendientes.length - yaProcesadas,
    coleccionJob: "jobs_consulta",
  });
};
