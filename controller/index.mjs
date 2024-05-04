import { chromium } from "playwright";

export default async function run(guias) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www3.interrapidisimo.com/SitioLogin/auth/login");
  await page.locator("#usernameLogin").fill("aquitania.boyaca");
  await page.locator("#passwordLogin").fill("LUCHO1972");
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
    await newPage.locator("#btnShow").click();

    try {
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
      } else {
        let shipmentDetails = {
          num_guia: guia,
          remitente: {
            tipo_identificacion: await newPage.inputValue(
              'input[name="tbxTipIdentificacion"]'
            ),
            numero_identificacion: await newPage.inputValue(
              'input[name="tbxIdentificacionRemi"]'
            ),
            nombre: await newPage.inputValue(
              'input[name="tbxNombreRemitente"]'
            ),
            direccion: await newPage.inputValue(
              'input[name="tbxDireccionRemi"]'
            ),
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
            direccion: await newPage.inputValue(
              'input[name="tbxDireccionDes"]'
            ),
            celular: await newPage.inputValue('input[name="tbxTelefonoDes"]'),
            correo: await newPage.inputValue('input[name="tbxCorreoDes"]'),
          },
          tipo_entrega: await newPage.inputValue(
            'input[name="tbxTipoEntrega"]'
          ),
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

        data.push(shipmentDetails);
      }
    } catch (error) {
      console.error(`Error al procesar la guía ${guia}:`, error);
    }

    // await newPage.waitForTimeout(500); // Esperar 0.5 segundos entre cada consulta
  }
  console.log(JSON.stringify(data, null, 2));
  return data;
  //   await browser.close();
}
