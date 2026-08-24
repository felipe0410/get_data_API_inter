// ============================================================================
// Worker — consulta las guías y escribe el resultado en Firestore
// ============================================================================
// Se invoca asíncrono desde el dispatcher, así que no hay nadie esperando la
// respuesta: el estado se publica en jobs_consulta/{jobId} y los documentos
// finales en envios/{guia}.
//
// Un job = un login = una sesión contra el portal, sin importar cuántas guías
// traiga. Ese era el costo grande de trocear desde la web: ~15s de login por
// cada lote.
// ============================================================================
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { db, ESTADOS, FieldValue, jobRef } from "./firestore.mjs";
import {
  delay,
  getKeyinter,
  GUIA_DELAY_MS,
  inputByName,
  inputById,
  openSession,
  queryGuia,
} from "./vendor/interClient.mjs";

const lambda = new LambdaClient({});
const USER = process.env.INTER_USER || "aquitania.boyaca";
const BATCH_LIMIT = 500; // límite duro de writeBatch en Firestore

// Cuánto tiempo se permite trabajar antes de encadenar otro tramo. El techo de
// Lambda son 15 min; se corta antes para que quede margen de sobra para el
// último writeBatch y para invocar la continuación.
const PRESUPUESTO_MS = Number(process.env.PRESUPUESTO_MS ?? 12 * 60_000);

/** "12.500" -> 12500. Igual que convertirMonedaANumero en la web. */
function monedaANumero(monto) {
  if (typeof monto !== "string") return 0;
  const n = parseFloat(monto.replace(/[^0-9,]/g, "").replace(/,/g, "."));
  return isNaN(n) ? 0 : n;
}

/** Firestore rechaza undefined pero acepta null. */
function limpiarUndefined(obj) {
  const limpio = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const anidado = {};
      for (const [nk, nv] of Object.entries(v)) if (nv !== undefined) anidado[nk] = nv;
      limpio[k] = anidado;
    } else {
      limpio[k] = v;
    }
  }
  return limpio;
}

/** Consulta una guía y devuelve el doc listo para Firestore, o null. */
function armarDoc(html, item, domiciliary) {
  const addressee = inputByName(html, "tbxNombreDes");
  if (!addressee) return null; // guía sin datos o número inválido

  const colombiaDate = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Bogota",
  });
  const shippingCostPortal = inputById(html, "tbxValorComercial");

  const base = {
    timestamp: new Date(colombiaDate + "T00:00:00-05:00").getTime(),
    colombiaDate,
    addressee,
    box: item.box ?? null,
    courierAttempt1: domiciliary ? Date.now() : null,
    courierAttempt2: null,
    courierAttempt3: null,
    deliverTo: inputByName(html, "tbxTipoEntrega"),
    deliveryDate: null,
    guide: item.guide,
    intakeDate: new Date().toISOString(),
    packageNumber: item.packageNumber ?? 0,
    returnDate: null,
    // El valor lo pone el formulario; si no vino, se deriva del portal.
    valor: item.valor ?? monedaANumero(shippingCostPortal ?? "0"),
    shippingCost: item.shippingCost ?? shippingCostPortal,
    status: domiciliary ? "mensajero" : "oficina",
    uid: item.guide,
    updateDate: null,
    revision: item.revision ?? false,
    remitente: {
      tipo_identificacion: inputByName(html, "tbxTipIdentificacion"),
      numero_identificacion: inputByName(html, "tbxIdentificacionRemi"),
      nombre: inputByName(html, "tbxNombreRemitente"),
      direccion: inputByName(html, "tbxDireccionRemi"),
      celular: inputByName(html, "tbxTelefonoRem"),
      correo: inputByName(html, "tbxCorreoRem"),
    },
    destinatario: {
      tipo_identificacion: inputByName(html, "tbxTipIdentificacionDes"),
      numero_identificacion: inputByName(html, "tbxIdentificacionDes"),
      nombre: inputByName(html, "tbxNombreDes"),
      direccion: inputByName(html, "tbxDireccionDes"),
      celular: inputByName(html, "tbxTelefonoDes"),
      correo: inputByName(html, "tbxCorreoDes"),
    },
    pago: item.pago ?? inputByName(html, "txtFormaPago"),
    ciudad: inputByName(html, "tbxCiudadOrigen"),
    servicio: inputByName(html, "tbxServicio"),
    destino: inputByName(html, "tbxCiudadDestino"),
    fecha_de_admision: inputByName(html, "tbxFechaEnvio"),
    fecha_estimada_de_entrega: inputByName(html, "tbxHorasEntrega"),
    fecha_de_admision_timestamp_local: Date.now(),
    fecha_de_admision_timestamp: FieldValue.serverTimestamp(),
  };

  if (domiciliary) base.box = "0";
  return limpiarUndefined(base);
}

async function guardar(docs) {
  const enviosRef = db.collection("envios");
  let guardados = 0;
  for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
    const chunk = docs.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    // set() plano, como hacía la web: el documento se reemplaza entero y no
    // sobreviven campos de una carga anterior de la misma guía.
    for (const d of chunk) batch.set(enviosRef.doc(d.uid), d);
    await batch.commit();
    guardados += chunk.length;
  }
  return guardados;
}

export const handler = async (event) => {
  const { jobId, items, password, domiciliary, tramo = 0 } = event;
  const ref = jobRef(jobId);
  const inicio = Date.now();

  await ref.update({
    estado: ESTADOS.PROCESANDO,
    tramo,
    actualizadoEn: FieldValue.serverTimestamp(),
  });

  const pendientes = [...items];
  const docs = [];
  const errores = [];
  let sinDatos = 0;
  let consultadas = 0;

  try {
    // Un login para todo el tramo. La sesión (cookie + ViewState) se mantiene
    // viva entre guías; no se reabre por cada una.
    const keyinter = await getKeyinter(USER, password);
    const session = await openSession(keyinter);

    while (pendientes.length) {
      // Cortar ANTES de quedarse sin tiempo: lo que falta va a otro tramo.
      if (Date.now() - inicio > PRESUPUESTO_MS) break;

      const item = pendientes.shift();
      if (consultadas++ > 0) await delay(GUIA_DELAY_MS); // espaciado anti-WAF

      try {
        const html = await queryGuia(session, item.guide);
        const doc = armarDoc(html, item, domiciliary);
        if (doc) docs.push(doc);
        else sinDatos++;
      } catch (error) {
        console.error(`[worker] guía ${item.guide}:`, error.message);
        errores.push({ guia: item.guide, message: error.message });
      }
    }

    const guardadas = docs.length ? await guardar(docs) : 0;
    const transcurrido = Date.now() - inicio;
    const procesadas = docs.length + sinDatos + errores.length;

    await ref.update({
      procesadas: FieldValue.increment(procesadas),
      guardadas: FieldValue.increment(guardadas),
      sinDatos: FieldValue.increment(sinDatos),
      // arrayUnion() sin argumentos lanza: el campo solo se toca si hubo algo.
      ...(errores.length ? { errores: FieldValue.arrayUnion(...errores) } : {}),
      msPorGuia: procesadas ? Math.round(transcurrido / procesadas) : null,
      actualizadoEn: FieldValue.serverTimestamp(),
    });

    // ¿Quedó trabajo? Se encadena otro tramo con las guías que faltan. El
    // tramo nuevo hace su propio login: es el precio de no tener techo.
    if (pendientes.length) {
      console.log(
        `[worker] job ${jobId} tramo ${tramo}: ${procesadas} listas, ${pendientes.length} para el tramo ${tramo + 1}`
      );
      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: Buffer.from(
            JSON.stringify({
              jobId,
              items: pendientes,
              password,
              domiciliary,
              tramo: tramo + 1,
            })
          ),
        })
      );
      return;
    }

    await ref.update({
      estado: ESTADOS.COMPLETADO,
      terminadoEn: FieldValue.serverTimestamp(),
      actualizadoEn: FieldValue.serverTimestamp(),
    });
    console.log(
      `[worker] job ${jobId} completado: ${guardadas} guardadas, ${sinDatos} sin datos, ${errores.length} con error`
    );
  } catch (error) {
    // Falla de sesión o de login: el job entero no puede seguir.
    console.error(`[worker] job ${jobId} abortado:`, error);
    await ref.update({
      estado: ESTADOS.ERROR,
      errores: FieldValue.arrayUnion({ etapa: "sesion", message: error.message }),
      actualizadoEn: FieldValue.serverTimestamp(),
    });
    throw error;
  }
};
