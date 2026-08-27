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
import { createHash } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { db, ESTADOS, FieldValue, jobRef, procesadosRef } from "./firestore.mjs";
import {
  delay,
  getKeyinter,
  GuiaDesincronizada,
  GUIA_DELAY_MS,
  inputByName,
  inputById,
  openSession,
  queryGuia,
} from "./vendor/interClient.mjs";

const lambda = new LambdaClient({});
const USER = process.env.INTER_USER || "aquitania.boyaca";
const BATCH_LIMIT = 500; // límite duro de writeBatch en Firestore

// La notificación por WhatsApp la sigue haciendo la web: ahí viven la lógica de
// plantillas y la API key de Infobip, que no tiene por qué estar en dos lados.
// El worker solo la dispara, para que el navegador no tenga que seguir abierto
// hasta que termine el guardado.
const WEB_API_BASE = process.env.WEB_API_BASE;
const NOTIFY_TOKEN = process.env.NOTIFY_TOKEN;

// Cuánto tiempo se permite trabajar antes de encadenar otro tramo. El techo de
// Lambda son 15 min; se corta antes para que quede margen de sobra para el
// último writeBatch y para invocar la continuación.
const PRESUPUESTO_MS = Number(process.env.PRESUPUESTO_MS ?? 12 * 60_000);

// Cada cuántas guías se vuelca el avance a Firestore. Es el paso de la barra
// de progreso que ve el operador, y el tamaño del lote de WhatsApp.
const CHECKPOINT = Number(process.env.CHECKPOINT ?? 20);

// Rondas de reintento para las guías que quedaron desincronizadas, y cuánto se
// espera antes de cada una. La sesión nueva suele arreglarlo en el acto; esta
// espera es para el caso en que no, que se parece más a un bloqueo temporal
// del portal y donde insistir de inmediato solo empeora las cosas.
const MAX_RONDAS = Number(process.env.MAX_RONDAS ?? 3);
const ESPERA_RONDA_MS = Number(process.env.ESPERA_RONDA_MS ?? 120_000);

// A quién avisarle cuando, después de todas las rondas, quedaron guías sin
// guardar. Es el único caso que necesita que alguien mire.
const ALERTA_WHATSAPP = process.env.ALERTA_WHATSAPP || "3105762035";

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

async function guardar(docs, coleccion) {
  const enviosRef = db.collection(coleccion);
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

/**
 * Dispara los WhatsApp de los envíos recién guardados.
 *
 * No es fatal: si falla, las guías ya quedaron en Firestore, que es lo que
 * importa. El resultado se registra en el job para que se vea desde la web.
 */
async function notificar(docs, domiciliary) {
  if (!docs.length) return null;
  if (!WEB_API_BASE) {
    console.warn("[worker] WEB_API_BASE sin configurar: no se notifica por WhatsApp");
    return null;
  }

  // El centinela de serverTimestamp no sobrevive a JSON.stringify, y la ruta
  // de la web no lo usa: se saca antes de mandar.
  const shipments = docs.map(({ fecha_de_admision_timestamp, ...resto }) => resto);

  try {
    const res = await fetch(`${WEB_API_BASE}/api/whatsapp/notify-shipments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(NOTIFY_TOKEN ? { "x-notify-token": NOTIFY_TOKEN } : {}),
      },
      body: JSON.stringify({
        shipments,
        tipo: domiciliary ? "domiciliario" : "oficina",
      }),
    });
    if (!res.ok) {
      const detalle = await res.text();
      throw new Error(`${res.status}: ${detalle.slice(0, 200)}`);
    }
    const r = await res.json();
    console.log(`[worker] WhatsApp: ${r.sent}/${r.total} enviados`);

    // La ruta devuelve el detalle por guía y lo estábamos tirando. Sin eso, el
    // operador ve "18 enviados" y no tiene forma de saber a cuáles dos no les
    // llegó, que es justo lo accionable.
    const fallidos = (r.results ?? [])
      .filter((x) => !x.sent)
      .map((x) => ({
        guia: x.uid,
        telefono: x.phone || null,
        error: typeof x.error === "string" ? x.error : JSON.stringify(x.error ?? "desconocido"),
      }));

    return {
      enviados: r.sent ?? 0,
      fallidos: r.failed ?? fallidos.length,
      detalleFallidos: fallidos,
      total: r.total ?? shipments.length,
    };
  } catch (error) {
    console.error("[worker] falló la notificación por WhatsApp:", error.message);
    // Si la llamada entera falló, no llegó ninguno: se listan todos.
    return {
      enviados: 0,
      fallidos: shipments.length,
      detalleFallidos: shipments.map((s) => ({
        guia: s.uid,
        telefono: s.destinatario?.celular ?? null,
        error: error.message,
      })),
      total: shipments.length,
      error: error.message,
    };
  }
}

/**
 * Avisa por WhatsApp que quedaron guías sin guardar.
 *
 * Es el único aviso que va a un humano y no a un cliente, así que se manda al
 * número de la operación. En modo prueba no se manda nada: probar no debería
 * despertar a nadie.
 *
 * El aviso puede no llegar —WhatsApp solo deja mandar texto libre dentro de
 * las 24h siguientes a un mensaje del destinatario— y por eso no es el único
 * canal: el fallo queda escrito en el job, que es lo que pinta el tablero de
 * inicio. El WhatsApp adelanta la noticia; el tablero es el que no se pierde.
 */
async function alertar(guias, { jobId, fecha, tipo, modoPrueba, ref }) {
  if (modoPrueba) {
    console.log(`[worker] modo prueba: no se manda la alerta de ${guias.length} guías`);
    return;
  }
  if (!WEB_API_BASE) {
    console.warn("[worker] WEB_API_BASE sin configurar: no se manda la alerta");
    return;
  }

  const texto =
    `⚠️ Quedaron ${guias.length} guías sin guardar (${tipo}, ${fecha}).\n\n` +
    `${guias.slice(0, 10).join(", ")}${guias.length > 10 ? ` y ${guias.length - 10} más` : ""}\n\n` +
    `El portal no respondió después de ${MAX_RONDAS} reintentos. Hay que revisar y volver a guardar.`;

  try {
    const res = await fetch(`${WEB_API_BASE}/api/whatsapp/alerta`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(NOTIFY_TOKEN ? { "x-notify-token": NOTIFY_TOKEN } : {}),
      },
      body: JSON.stringify({ telefono: ALERTA_WHATSAPP, texto, jobId }),
    });
    const cuerpo = await res.json().catch(() => ({}));
    if (!res.ok || !cuerpo.enviado) {
      throw new Error(cuerpo.error || `${res.status}`);
    }
    console.log(`[worker] alerta enviada a ${ALERTA_WHATSAPP}`);
    await ref.update({ alertaEnviada: true, actualizadoEn: FieldValue.serverTimestamp() });
  } catch (error) {
    // Que no se pueda avisar no puede tumbar el job: las guías buenas ya están
    // guardadas y el fallo ya quedó escrito.
    console.error("[worker] no se pudo mandar la alerta:", error.message);
    await ref
      .update({ alertaEnviada: false, alertaError: error.message })
      .catch(() => {});
  }
}

/**
 * Deja constancia de cuál contraseña autenticó bien contra el portal.
 *
 * Guarda un hash, nunca la contraseña. Con eso alcanza para lo único que hace
 * falta: que la web pueda decir "esta es la que funcionó" en vez de dejar
 * elegir a ciegas entre varias y descubrir el error 16 segundos después, con
 * un job fallido de por medio.
 *
 * No hace falta guardar la contraseña en claro para que los reintentos sean
 * automáticos: la contraseña viaja dentro del job, así que cada ronda ya la
 * tiene. Guardarla en reposo daría un permiso que nadie necesita.
 */
async function registrarPasswordBuena(password) {
  try {
    const hash = createHash("sha256").update(`inter:${USER}:${password}`).digest("hex");
    await db.collection("config").doc("inter_auth").set(
      {
        hash,
        usuario: USER,
        verificadaEn: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    // Es un dato de conveniencia: si no se puede escribir, el job sigue igual.
    console.error("[worker] no se pudo registrar la contraseña buena:", error.message);
  }
}

export const handler = async (event) => {
  const {
    jobId, items, password, domiciliary,
    modoPrueba = false, fecha, tipo = "oficina", tramo = 0,
    // Ronda de reintento. 0 es la corrida normal; de 1 en adelante son las
    // guías que quedaron desincronizadas y se vuelven a pedir con sesión nueva.
    ronda = 0, esperaMs = 0,
  } = event;
  // En modo prueba nada toca producción: otra colección y sin WhatsApp.
  const coleccion = modoPrueba ? "envios_prueba" : "envios";
  const ref = jobRef(jobId);

  // La espera va antes de arrancar el cronómetro: no es tiempo de trabajo y no
  // debe comerse el presupuesto del tramo.
  if (esperaMs > 0) {
    console.log(`[worker] job ${jobId} ronda ${ronda}: esperando ${Math.round(esperaMs / 1000)}s antes de reintentar`);
    await delay(esperaMs);
  }
  const inicio = Date.now();

  await ref.update({
    estado: ESTADOS.PROCESANDO,
    tramo,
    actualizadoEn: FieldValue.serverTimestamp(),
  });

  const pendientes = [...items];
  const docs = [];
  const errores = [];
  // Las guías sin datos se guardan por número y no como un contador: sin eso,
  // el operador ve "3 sin datos" y no tiene forma de saber cuáles revisar.
  const sinDatos = [];
  // Guías que fallaron incluso con una sesión recién abierta: van a otra ronda.
  const desincronizadas = [];
  let consultadas = 0;

  // Acumulados del tramo, para el log y para decidir el encadenado.
  let procesadasTramo = 0;
  let guardadasTramo = 0;

  try {
    // Un login para todo el tramo. La sesión (cookie + ViewState) se mantiene
    // viva entre guías; no se reabre por cada una.
    const keyinter = await getKeyinter(USER, password);
    await registrarPasswordBuena(password);
    let session = await openSession(keyinter);

    /**
     * Abre una sesión nueva reusando el token: es un GET, no un login.
     *
     * Cuesta ~1s contra los ~16s del login completo, porque el keyinter vive
     * 30 min y `getKeyinter` lo tiene cacheado. Barato como para usarlo de
     * forma preventiva y no solo cuando algo ya se rompió.
     */
    async function renovarSesion(motivo) {
      session = await openSession(keyinter);
      console.log(`[worker] sesión renovada (${motivo})`);
    }
    // El login pesa ~17s y es fijo por tramo, no por guía. Medirlo aparte es lo
    // que hace que msPorGuia sirva para estimar: con un job de una guía, un
    // promedio que lo incluya dice 17s cuando la consulta tarda 2.
    const msLogin = Date.now() - inicio;
    const inicioConsultas = Date.now();

    /**
     * Vuelca a Firestore lo acumulado hasta ahora: guarda los documentos,
     * notifica y actualiza los contadores del job.
     *
     * Se llama cada CHECKPOINT guías y no solo al final del tramo. Con 200
     * guías el tramo dura ~7 min, y actualizar el job una sola vez dejaba a la
     * web mirando "0/200" todo ese rato para después saltar al total: la barra
     * de progreso que ve el operador no mostraba nada. De paso acota la memoria
     * y hace que un fallo del contenedor no se lleve el tramo entero.
     */
    async function volcar() {
      const procesadas = docs.length + sinDatos.length + errores.length;
      if (!procesadas) return;

      const guardadas = docs.length ? await guardar(docs, coleccion) : 0;

      // Se notifica por bloque y no al final del job: así los destinatarios de
      // las primeras guías reciben el mensaje sin esperar a que termine todo.
      const wa = guardadas && !modoPrueba ? await notificar(docs, domiciliary) : null;

      // Bitácora del día. Cumple dos funciones a la vez:
      //
      //  - `[tipo]` es la lista que usa el dedup. Solo entran las guías que se
      //    guardaron bien, así que las que fallaron o no trajeron datos se
      //    reintentan la próxima vez que se aprieta el botón.
      //  - `resumen` es para mirar: qué se guardó, qué no trajo datos, qué
      //    falló y por qué. Sin esto el operador ve "3 sin datos" y no tiene
      //    forma de saber cuáles revisar.
      //
      // Todo en un documento por fecha: el estado del día se lee de una.
      // En modo prueba no se escribe nada, o la corrida real saltaría estas.
      const huboAlgo = guardadas || sinDatos.length || errores.length;
      if (huboAlgo && fecha && !modoPrueba) {
        try {
          await procesadosRef(fecha).set(
            {
              ...(guardadas
                ? { [tipo]: FieldValue.arrayUnion(...docs.map((d) => d.uid)) }
                : {}),
              jobs: FieldValue.arrayUnion(jobId),
              resumen: {
                [tipo]: {
                  guardadas: FieldValue.increment(guardadas),
                  ...(sinDatos.length
                    ? { sinDatos: FieldValue.arrayUnion(...sinDatos) }
                    : {}),
                  ...(errores.length
                    ? { errores: FieldValue.arrayUnion(...errores) }
                    : {}),
                  ...(wa
                    ? {
                        whatsappEnviados: FieldValue.increment(wa.enviados),
                        whatsappFallidos: FieldValue.increment(wa.fallidos),
                        ...(wa.detalleFallidos?.length
                          ? { whatsappSinEnviar: FieldValue.arrayUnion(...wa.detalleFallidos) }
                          : {}),
                      }
                    : {}),
                  ultimoJob: jobId,
                  ultimaVez: FieldValue.serverTimestamp(),
                },
              },
              actualizadoEn: FieldValue.serverTimestamp(),
            },
            { merge: true } // el doc del día puede no existir todavía
          );
        } catch (error) {
          // No es fatal: los envíos ya están guardados. Lo peor que pasa es
          // que la próxima corrida vuelva a consultar estas guías.
          console.error("[worker] no se pudo escribir la bitácora:", error.message);
        }
      }

      // Un solo arrayUnion con todo: si `errores` apareciera dos veces en el
      // literal, la segunda clave pisaría a la primera y se perderían los
      // fallos de guía cuando además falla el WhatsApp.
      const paraRegistrar = [...errores];
      if (wa?.error) paraRegistrar.push({ etapa: "whatsapp", message: wa.error });

      procesadasTramo += procesadas;
      guardadasTramo += guardadas;

      await ref.update({
        procesadas: FieldValue.increment(procesadas),
        guardadas: FieldValue.increment(guardadas),
        sinDatos: FieldValue.increment(sinDatos.length),
        // arrayUnion() sin argumentos lanza: el campo solo se toca si hubo algo.
        ...(paraRegistrar.length ? { errores: FieldValue.arrayUnion(...paraRegistrar) } : {}),
        ...(wa
          ? {
              whatsappEnviados: FieldValue.increment(wa.enviados),
              whatsappFallidos: FieldValue.increment(wa.fallidos),
            }
          : {}),
        // Sin el login: es el número con el que se estima cuánto tarda un job.
        msPorGuia: Math.round((Date.now() - inicioConsultas) / procesadasTramo),
        msLogin,
        actualizadoEn: FieldValue.serverTimestamp(),
      });

      docs.length = 0;
      errores.length = 0;
      sinDatos.length = 0;
    }

    while (pendientes.length) {
      // Cortar ANTES de quedarse sin tiempo: lo que falta va a otro tramo.
      if (Date.now() - inicio > PRESUPUESTO_MS) break;

      const item = pendientes.shift();
      if (consultadas++ > 0) await delay(GUIA_DELAY_MS); // espaciado anti-WAF

      try {
        const html = await queryGuia(session, item.guide);
        const doc = armarDoc(html, item, domiciliary);
        if (doc) docs.push(doc);
        else sinDatos.push(item.guide);
      } catch (error) {
        if (error instanceof GuiaDesincronizada) {
          // La sesión quedó pegada mostrando otra guía y a partir de aquí
          // TODAS las respuestas serían esa misma página. Reintentar sobre la
          // misma sesión no sirve: hay que tirarla y abrir otra.
          try {
            await renovarSesion(`desincronizada en ${item.guide}`);
            const html = await queryGuia(session, item.guide);
            const doc = armarDoc(html, item, domiciliary);
            if (doc) docs.push(doc);
            else sinDatos.push(item.guide);
          } catch (segundo) {
            // Con sesión nueva y sigue fallando: esto ya no es una sesión
            // vencida. Se aparta para una ronda posterior en vez de quemar
            // las guías que faltan contra un portal que no está respondiendo.
            console.error(`[worker] guía ${item.guide} sigue fallando con sesión nueva:`, segundo.message);
            desincronizadas.push(item);
          }
        } else {
          console.error(`[worker] guía ${item.guide}:`, error.message);
          errores.push({ guia: item.guide, message: error.message });
        }
      }

      if (docs.length + sinDatos.length + errores.length >= CHECKPOINT) {
        await volcar();
        // Volcar tarda: escribe en Firestore y manda los WhatsApp del lote. El
        // portal no aguanta esa pausa y deja la sesión pegada — el 27/08/2026,
        // con CHECKPOINT en 20, las guías 21 a 29 recibieron todas la página de
        // la 20. Renovar aquí sale ~1s y evita el problema de raíz.
        await renovarSesion(`pausa tras volcar ${consultadas} guías`);
      }
    }

    await volcar(); // lo que quedó suelto

    // ¿Quedó trabajo? Se encadena otro tramo con las guías que faltan. El
    // tramo nuevo hace su propio login: es el precio de no tener techo.
    // Las desincronizadas viajan con las pendientes: el tramo siguiente abre
    // sesión propia, que es justo lo que necesitan.
    if (pendientes.length) {
      pendientes.push(...desincronizadas);
      desincronizadas.length = 0;
      console.log(
        `[worker] job ${jobId} tramo ${tramo}: ${procesadasTramo} listas, ${pendientes.length} para el tramo ${tramo + 1}`
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
              modoPrueba,
              fecha,
              tipo,
              tramo: tramo + 1,
              ronda,
            })
          ),
        })
      );
      return;
    }

    // Quedaron guías que no respondieron ni con sesión nueva. Se reintentan
    // solas: el operador ya apretó el botón, no tiene por qué volver a hacerlo.
    if (desincronizadas.length) {
      if (ronda < MAX_RONDAS) {
        console.log(
          `[worker] job ${jobId}: ${desincronizadas.length} guías a la ronda ${ronda + 1} de ${MAX_RONDAS}`
        );
        await ref.update({
          estado: ESTADOS.PROCESANDO,
          ronda: ronda + 1,
          reintentando: desincronizadas.map((d) => d.guide),
          actualizadoEn: FieldValue.serverTimestamp(),
        });
        await lambda.send(
          new InvokeCommand({
            FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
            InvocationType: "Event",
            Payload: Buffer.from(
              JSON.stringify({
                jobId,
                items: desincronizadas,
                password, // la contraseña viaja con el job: la ronda no la pide
                domiciliary,
                modoPrueba,
                fecha,
                tipo,
                tramo: tramo + 1,
                ronda: ronda + 1,
                esperaMs: ESPERA_RONDA_MS,
              })
            ),
          })
        );
        return;
      }

      // Se agotaron las rondas. Esto sí necesita que alguien mire.
      const guias = desincronizadas.map((d) => d.guide);
      console.error(`[worker] job ${jobId}: ${guias.length} guías sin guardar tras ${MAX_RONDAS} rondas`);
      await ref.update({
        errores: FieldValue.arrayUnion(
          ...guias.map((guia) => ({
            guia,
            message: `Sin respuesta del portal tras ${MAX_RONDAS} rondas de reintento`,
          }))
        ),
        sinGuardar: guias,
        actualizadoEn: FieldValue.serverTimestamp(),
      });
      await alertar(guias, { jobId, fecha, tipo, modoPrueba, ref });
    }

    await ref.update({
      estado: ESTADOS.COMPLETADO,
      terminadoEn: FieldValue.serverTimestamp(),
      actualizadoEn: FieldValue.serverTimestamp(),
    });
    console.log(
      `[worker] job ${jobId} completado: ${guardadasTramo} guardadas en ${coleccion}${modoPrueba ? " (modo prueba: sin WhatsApp)" : ""}`
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
