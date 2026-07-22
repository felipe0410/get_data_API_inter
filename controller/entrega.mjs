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
  let newPage = await context.waitForEvent("page");
  await newPage.waitForLoadState("networkidle");

  const correctUrl =
    "http://reportes.interrapidisimo.com/Reportes/ExploradorEnvios/ExploradorEnvios.aspx";
  let data = [];

  for (let i = 0; i < guias.length; i++) {
    const guia = guias[i];

    // Verificamos si estamos en la URL correcta
    if (newPage.url() !== correctUrl) {
      console.log(`No estamos en la página correcta. Reabriendo "Explorador Envios"...`);
      await page.locator('div[title="Explorador Envios"]').click();
      await newPage.close();
      newPage = await context.waitForEvent("page");
      await newPage.waitForLoadState("networkidle");
      await delay(2000);
    }

    // Rellenar el número de guía
    await newPage.locator("#tbxNumeroGuia").fill(guia);

    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      try {
        await newPage.locator("#btnShow").click();
        await delay(1000);

        // Detectar si la página muestra el error ASP.NET
        const pageTitle = await newPage.title();
        const isServerError = pageTitle.includes("Server Error");

        if (isServerError) {
          console.log(`⚠️ Error del servidor detectado para la guía ${guia}. Reintentando...`);
          await newPage.close();
          await page.locator('div[title="Explorador Envios"]').click();
          newPage = await context.waitForEvent("page");
          await newPage.waitForLoadState("networkidle");
          await delay(2000);
          i--; // Reintentar la misma guía
          break;
        }

        // Verificamos si nos redirigieron fuera
        if (newPage.url() !== correctUrl) {
          console.log(`Nos salimos de la página correcta. Reabriendo...`);
          await newPage.close();
          await page.locator('div[title="Explorador Envios"]').click();
          newPage = await context.waitForEvent("page");
          await newPage.waitForLoadState("networkidle");
          await delay(2000);
          i--;
          break;
        }

        // Esperar datos o error modal
        await newPage.waitForFunction(
          () =>
            document.querySelector(".styleTextBox") ||
            document.querySelector(".modalPopupError"),
          null,
          { timeout: 30000 }
        );

        const hasError = await newPage.locator(".modalPopupError").isVisible();
        if (hasError) {
          console.log(`❌ Error con la guía ${guia}: No se pudo consultar el número de guía ingresado.`);
          await newPage.locator('.modalPopupError .button-blue[type="submit"]').click();
          retryCount++;
        } else {
          break; // Consulta exitosa
        }
      } catch (error) {
        console.error(`Error al procesar la guía ${guia}:`, error);

        if (newPage.isClosed()) {
          console.log("🔄 La pestaña se cerró. Reabriendo 'Explorador Envios'...");
          await page.locator('div[title="Explorador Envios"]').click();
          newPage = await context.waitForEvent("page");
          await newPage.waitForLoadState("networkidle");
          await delay(2000);
        }

        retryCount++;
      }
    }

    if (retryCount === maxRetries) {
      console.error(`❌ No se pudo procesar la guía ${guia} después de ${maxRetries} intentos.`);
      data.push({
        guia: guia,
        status: "ERROR",
        gestionEnvio: "No se pudo consultar",
        gestiones: [],
        error: "Máximo de reintentos alcanzado"
      });
      continue;
    }

    try {
      // Esperar a que los datos básicos estén disponibles
      await newPage.waitForSelector('input[name="tbxNombreDes"]', {
        timeout: 10000,
      });

      let shipmentResult = {
        guia: guia,
        destinatario: await newPage.inputValue('input[name="tbxNombreDes"]'),
        status: "PENDIENTE", // Por defecto
        gestionEnvio: null,
        gestiones: [],
        fechaConsulta: new Date().toISOString()
      };

      // 1. HACER CLIC EN LA PESTAÑA "Estado"
      console.log(`📋 Consultando estado de la guía ${guia}...`);
      
      try {
        // Buscar y hacer clic en la pestaña Estado
        await newPage.locator('#TabContainer2_TabPanel8_tab').click();
        await delay(1000);

        // Obtener el valor del campo "Gestion del Envio"
        const gestionEnvio = await newPage.inputValue('#TabContainer2_TabPanel8_tbxGestionEnvio');
        shipmentResult.gestionEnvio = gestionEnvio;

        if (gestionEnvio && gestionEnvio.toLowerCase().includes('entrega exitosa')) {
          shipmentResult.status = "ENTREGADO";
          console.log(`✅ Guía ${guia}: Estado inicial ENTREGADO - ${gestionEnvio}`);
        } else {
          shipmentResult.status = "PENDIENTE";
          console.log(`⏳ Guía ${guia}: Estado inicial PENDIENTE - ${gestionEnvio || 'Sin información'}`);
        }

      } catch (estadoError) {
        console.log(`⚠️ No se pudo obtener estado para la guía ${guia}:`, estadoError.message);
        shipmentResult.gestionEnvio = "Error al consultar estado";
      }

      // 2. SIEMPRE REVISAR "Gestion App" PARA VERIFICAR DEVOLUCIONES
      console.log(`📝 Revisando gestiones de la guía ${guia}...`);
      try {
        await newPage.locator('#__tab_TabContainer2_TabPanel4').click();
        await delay(1000);

        // Obtener las filas de la tabla de gestiones
        const gestionRows = await newPage.locator('#TabContainer2_TabPanel4_gvGestionApp tbody tr').all();
        
        for (let j = 1; j < gestionRows.length; j++) { // Empezar en 1 para saltar el header
          const cells = await gestionRows[j].locator('td').all();
          if (cells.length >= 3) {
            const fecha = await cells[0].textContent();
            const tipoEvidencia = await cells[1].textContent();
            const descripcion = await cells[2].textContent();
            
            shipmentResult.gestiones.push({
              fecha: fecha?.trim(),
              tipo: tipoEvidencia?.trim(),
              descripcion: descripcion?.trim()
            });

            // PRIORIDAD: Si hay devolución, sobrescribir el estado
            if (tipoEvidencia && tipoEvidencia.toLowerCase().includes('devolucion')) {
              shipmentResult.status = "DEVOLUCION";
              console.log(`🔄 Guía ${guia}: DEVOLUCIÓN detectada - ${tipoEvidencia}`);
            }
          }
        }

        console.log(`📝 Guía ${guia}: ${shipmentResult.gestiones.length} gestiones encontradas`);
        
        // Si hay gestiones pero no hay devoluciones, verificar otros estados
        if (shipmentResult.gestiones.length > 0 && shipmentResult.status !== "DEVOLUCION") {
          const ultimaGestion = shipmentResult.gestiones[shipmentResult.gestiones.length - 1];
          if (ultimaGestion.tipo && ultimaGestion.tipo.toLowerCase().includes('entrega')) {
            shipmentResult.status = "ENTREGADO";
          } else {
            shipmentResult.status = "PENDIENTE";
          }
        }
        
      } catch (gestionError) {
        console.log(`⚠️ No se pudo obtener gestiones para la guía ${guia}:`, gestionError.message);
      }

      data.push(shipmentResult);

    } catch (error) {
      console.error(`❌ Error al procesar la guía ${guia}:`, error);
      data.push({
        guia: guia,
        status: "ERROR",
        gestionEnvio: "Error en procesamiento",
        gestiones: [],
        error: error.message
      });
    }
  }

  console.log("\n=== RESUMEN DE CONSULTA ===");
  const entregados = data.filter(item => item.status === "ENTREGADO").length;
  const devoluciones = data.filter(item => item.status === "DEVOLUCION").length;
  const pendientes = data.filter(item => item.status === "PENDIENTE").length;
  const errores = data.filter(item => item.status === "ERROR").length;

  console.log(`✅ Entregados: ${entregados}`);
  console.log(`🔄 Devoluciones: ${devoluciones}`);
  console.log(`⏳ Pendientes: ${pendientes}`);
  console.log(`❌ Errores: ${errores}`);
  console.log(`📦 Total consultado: ${data.length}`);

  await browser.close();
  return {
    resumen: {
      total: data.length,
      entregados,
      devoluciones,
      pendientes,
      errores
    },
    guias: data
  };
}