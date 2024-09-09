import { chromium , firefox} from "playwright";

// Función para agregar un delay entre consultas
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function run(guias, password) {
  const browser = await firefox.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www3.interrapidisimo.com/SitioLogin/auth/login");
  await page.locator("#usernameLogin").fill("aquitania.boyaca");
  await page.locator("#passwordLogin").fill(password);
  await page.locator("#botonLogin").click();

  await page
    .locator('div[title="Explorador Envios"]')
    .waitFor({ state: "visible" });
  await page.locator('div[title="Explorador Envios"]').click();

  const [newPage] = await Promise.all([context.waitForEvent("page")]);

  await newPage.waitForLoadState("networkidle");

  let data = [];

  for (const guia of guias) {
    await newPage.locator("#tbxNumeroGuia").fill(guia);

    let retryCount = 0;
    const maxRetries = 1;

    while (retryCount < maxRetries) {
      try {
        await newPage.locator("#btnShow").click();
        await delay(1000);
        await newPage.waitForFunction(
          () =>
            document.querySelector(".styleTextBox") ||
            document.querySelector(".modalPopupError"),
          null,
          { timeout: 30000 }
        );

        const hasError = await newPage.locator(".modalPopupError").isVisible();
        if (hasError) {
          console.log(
            `Error con la guía ${guia}: No se pudo consultar el número de guía ingresado.`
          );
          await newPage
            .locator('.modalPopupError .button-blue[type="submit"]')
            .click();
          retryCount++;
        } else {
          break;
        }
      } catch (error) {
        console.error(
          `Error al intentar hacer clic en #btnShow para la guía ${guia}:`,
          error
        );
        retryCount++;
      }
    }

    if (retryCount === maxRetries) {
      console.error(
        `No se pudo procesar la guía ${guia} después de ${maxRetries} intentos.`
      );
      continue;
    }

    try {
      const currentDate = new Date().toISOString();
      let shipmentDetails = {
        addressee: await newPage.inputValue('input[name="tbxNombreDes"]'),
        box: null,
        courierAttempt1: null,
        courierAttempt2: null,
        courierAttempt3: null,
        deliverTo: await newPage.inputValue('input[name="tbxTipoEntrega"]'),
        deliveryDate: null,
        guide: guia,
        intakeDate: currentDate,
        packageNumber: null,
        returnDate: null,
        shippingCost: await newPage.inputValue("#tbxValorComercial"),
        status: "oficina",
        uid: guia,
        updateDate: null,
        revision: false,
        remitente: {
          tipo_identificacion: await newPage.inputValue(
            'input[name="tbxTipIdentificacion"]'
          ),
          numero_identificacion: await newPage.inputValue(
            'input[name="tbxIdentificacionRemi"]'
          ),
          nombre: await newPage.inputValue('input[name="tbxNombreRemitente"]'),
          direccion: await newPage.inputValue('input[name="tbxDireccionRemi"]'),
          celular: await newPage.inputValue('input[name="tbxTelefonoRem"]'),
          correo: await newPage.inputValue('input[name="tbxCorreoRem"]'),
        },
        destinatario: {
          tipo_identificacion: await newPage.inputValue(
            'input[name="tbxTipIdentificacionDes"]'
          ),
          numero_identificacion: await newPage.inputValue(
            'input[name="tbxIdentificacionDes"]'
          ),
          nombre: await newPage.inputValue('input[name="tbxNombreDes"]'),
          direccion: await newPage.inputValue('input[name="tbxDireccionDes"]'),
          celular: await newPage.inputValue('input[name="tbxTelefonoDes"]'),
          correo: await newPage.inputValue('input[name="tbxCorreoDes"]'),
        },
        pago: await newPage.inputValue('input[name="txtFormaPago"]'),
        ciudad: await newPage.inputValue('input[name="tbxCiudadOrigen"]'),
        servicio: await newPage.inputValue('input[name="tbxServicio"]'),
        destino: await newPage.inputValue('input[name="tbxCiudadDestino"]'),
        fecha_de_admision: await newPage.inputValue(
          'input[name="tbxFechaEnvio"]'
        ),
        fecha_estimada_de_entrega: await newPage.inputValue(
          'input[name="tbxHorasEntrega"]'
        ),
      };
      if (shipmentDetails.addressee.length > 0) {
        data.push(shipmentDetails);
      }
    } catch (error) {
      console.error(`Error al procesar la guía ${guia}:`, error);
    }
  }

  console.log(JSON.stringify(data, null, 2));
  await browser.close();
  return data;
}
