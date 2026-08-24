// /consult — datos del envío, 100% HTTP (sin Playwright).
// Mantiene la misma firma run(guias, password) y la misma forma de salida.
import {
  getKeyinter,
  openSession,
  queryGuia,
  inputByName,
  inputById,
  delay,
  GUIA_DELAY_MS,
} from "./interClient.mjs";

const USER = process.env.INTER_USER || "aquitania.boyaca";

export default async function run(guias, password) {
  const keyinter = await getKeyinter(USER, password);
  const session = await openSession(keyinter);

  const data = [];
  for (let i = 0; i < guias.length; i++) {
    const guia = guias[i];
    if (i > 0) await delay(GUIA_DELAY_MS); // espaciado anti-WAF
    let html;
    try {
      html = await queryGuia(session, guia);
    } catch (error) {
      console.error(`Error al consultar la guía ${guia}:`, error.message);
      continue;
    }

    const addressee = inputByName(html, "tbxNombreDes");
    if (!addressee) {
      // Guía sin datos (número inválido o sin resultado): se omite, como antes.
      console.log(`Guía ${guia}: sin datos.`);
      continue;
    }

    const colombiaDate = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Bogota",
    });
    const colombiaTimestamp = new Date(colombiaDate + "T00:00:00-05:00").getTime();
    const currentDate = new Date().toISOString();

    data.push({
      timestamp: colombiaTimestamp,
      colombiaDate,
      addressee,
      box: null,
      courierAttempt1: null,
      courierAttempt2: null,
      courierAttempt3: null,
      deliverTo: inputByName(html, "tbxTipoEntrega"),
      deliveryDate: null,
      guide: guia,
      intakeDate: currentDate,
      packageNumber: null,
      returnDate: null,
      shippingCost: inputById(html, "tbxValorComercial"),
      status: "oficina",
      uid: guia,
      updateDate: null,
      revision: false,
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
      pago: inputByName(html, "txtFormaPago"),
      ciudad: inputByName(html, "tbxCiudadOrigen"),
      servicio: inputByName(html, "tbxServicio"),
      destino: inputByName(html, "tbxCiudadDestino"),
      fecha_de_admision: inputByName(html, "tbxFechaEnvio"),
      fecha_estimada_de_entrega: inputByName(html, "tbxHorasEntrega"),
    });
  }

  console.log(`${data.length}/${guias.length} guías consultadas (HTTP).`);
  return data;
}
