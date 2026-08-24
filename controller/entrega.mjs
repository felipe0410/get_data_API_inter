// /entregar — estado + gestiones, 100% HTTP (sin Playwright).
// Mantiene la firma run(guias, password) y la forma de salida { resumen, guias }.
import {
  getKeyinter,
  openSession,
  queryGuia,
  switchTab,
  inputByName,
  gestionRows,
  delay,
  GUIA_DELAY_MS,
  TAB_ESTADO,
  TAB_GESTION_APP,
} from "./interClient.mjs";

const USER = process.env.INTER_USER || "aquitania.boyaca";

function clasificar(gestionEnvio, gestiones) {
  const ge = (gestionEnvio || "").toLowerCase();
  // 1) Base según "Gestión del Envío"
  let status = ge.includes("entrega exitosa") ? "ENTREGADO" : "PENDIENTE";
  // 2) Una devolución en las gestiones tiene prioridad
  for (const g of gestiones) {
    if ((g.tipo || "").toLowerCase().includes("devolucion")) return "DEVOLUCION";
  }
  // 3) Si hay una gestión de entrega, marcar ENTREGADO (sin degradar a PENDIENTE)
  for (const g of gestiones) {
    if ((g.tipo || "").toLowerCase().includes("entrega")) status = "ENTREGADO";
  }
  return status;
}

export default async function run(guias, password) {
  const keyinter = await getKeyinter(USER, password);
  const session = await openSession(keyinter);

  const data = [];
  for (let i = 0; i < guias.length; i++) {
    const guia = guias[i];
    if (i > 0) await delay(GUIA_DELAY_MS); // espaciado anti-WAF
    try {
      const consulta = await queryGuia(session, guia);
      const destinatario = inputByName(consulta, "tbxNombreDes");

      if (!destinatario) {
        data.push({
          guia,
          status: "ERROR",
          gestionEnvio: "No se pudo consultar",
          gestiones: [],
          error: "Guía sin datos o número inválido",
        });
        continue;
      }

      // Pestaña Estado -> "Gestión del Envío"
      const estadoHtml = await switchTab(session, TAB_ESTADO);
      const gestionEnvio = inputByName(
        estadoHtml,
        "TabContainer2$TabPanel8$tbxGestionEnvio"
      );

      // Pestaña Gestión App -> tabla de gestiones
      const gestionHtml = await switchTab(session, TAB_GESTION_APP);
      const gestiones = gestionRows(gestionHtml);

      const status = clasificar(gestionEnvio, gestiones);

      data.push({
        guia,
        destinatario,
        status,
        gestionEnvio: gestionEnvio || null,
        gestiones,
        fechaConsulta: new Date().toISOString(),
      });
    } catch (error) {
      console.error(`Error al procesar la guía ${guia}:`, error.message);
      data.push({
        guia,
        status: "ERROR",
        gestionEnvio: "Error en procesamiento",
        gestiones: [],
        error: error.message,
      });
    }
  }

  const resumen = {
    total: data.length,
    entregados: data.filter((d) => d.status === "ENTREGADO").length,
    devoluciones: data.filter((d) => d.status === "DEVOLUCION").length,
    pendientes: data.filter((d) => d.status === "PENDIENTE").length,
    errores: data.filter((d) => d.status === "ERROR").length,
  };
  console.log("Resumen /entregar:", JSON.stringify(resumen));

  return { resumen, guias: data };
}
