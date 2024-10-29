import { chromium } from "playwright";

// Función para agregar un delay entre consultas
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function run(guias, password) {
  const browser = await chromium.launch({ headless: false });
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

  // Abrimos la primera pestaña nueva (Explorador Envios)
  let newPage = (await context.waitForEvent("page"));
  await newPage.waitForLoadState("networkidle");

  const correctUrl =
    "http://reportes.interrapidisimo.com/Reportes/ExploradorEnvios/ExploradorEnvios.aspx";
  let data = [];

  for (let i = 0; i < guias.length; i++) {
    const guia = guias[i];

    // Verificamos si estamos en la URL correcta en la nueva pestaña
    if (newPage.url() !== correctUrl) {
      console.log(
        `No estamos en la página correcta. Haciendo clic nuevamente en "Explorador Envios"...`
      );
      
      // Volvemos a la pestaña principal y hacemos clic en "Explorador Envios"
      await page.locator('div[title="Explorador Envios"]').click();

      // Cerramos la pestaña anterior y capturamos la nueva pestaña
      await newPage.close();
      newPage = (await context.waitForEvent("page"));
      await newPage.waitForLoadState("networkidle");

      // Reiniciamos la espera para la página correcta
      await delay(2000);
    }

    // Rellenar el número de guía
    await newPage.locator("#tbxNumeroGuia").fill(guia);

    let retryCount = 0;
    const maxRetries = 1;

    while (retryCount < maxRetries) {
      try {
        await newPage.locator("#btnShow").click();
        await delay(500); // Esperamos 2 segundos después de la consulta

        // Verificamos si estamos en la URL correcta después de la consulta
        if (newPage.url() !== correctUrl) {
          console.log(
            `Nos salimos de la página correcta. Haciendo clic en "Explorador Envios" nuevamente...`
          );
          
          // Hacemos clic nuevamente en "Explorador Envios" para reabrir la pestaña
          await page.locator('div[title="Explorador Envios"]').click();

          // Cerramos la pestaña anterior y capturamos la nueva pestaña
          await newPage.close();
          newPage = (await context.waitForEvent("page"));
          await newPage.waitForLoadState("networkidle");

          // Reiniciamos la consulta desde la misma guía
          i--; // Retrocedemos en el índice para volver a intentar la consulta con la misma guía
          break; // Salimos del bucle para intentar nuevamente
        }

        // Esperamos a que se cargue el resultado de la guía o se muestre un error
        await newPage.waitForFunction(
          () =>
            document.querySelector(".styleTextBox") ||
            document.querySelector(".modalPopupError"),
          null,
          { timeout: 30000 }
        );

        // Verificamos si hubo un error en la consulta
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
          break; // Si no hay errores, salimos del bucle de reintentos
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
